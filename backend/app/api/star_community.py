"""Сообщество Звезды: правила и приветствие, фильтр слов, свои роли (теги), тайм-ауты, журнал.

Права те же, что у встроенных ролей: настройки и теги — владелец и админы, тайм-аут — кто
может выгонять (модераторы по умолчанию) и только тем, кто ниже рангом.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import (
    _broadcast,
    _forbid,
    _load_membership,
    _target_member,
    _user_out,
    broadcast_member,
)
from app.core import notify, star_audit
from app.core import stars as rules
from app.core import livekit, voice
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.star import Star, StarAudit, StarChannel, StarMember, StarMemberTag, StarTag
from app.models.user import User
from app.schemas.star import StarTagOut, StarUserOut

router = APIRouter(prefix="/stars", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# Как в разборе упоминаний (notify._MENTION): буквы, цифры, «_» и «.».
HANDLE_RE = re.compile(r"[\w.]{2,32}")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _admin(db: AsyncSession, star_id: str, user: User) -> tuple[Star, StarMember]:
    star, me = await _load_membership(db, star_id, user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid("Это настраивают владелец и админы")
    return star, me


# --- Правила, приветствие, фильтр слов, звуковая панель -----------------------


class CommunitySettings(BaseModel):
    rules_text: str | None = Field(default=None, max_length=rules.MAX_RULES_LENGTH)
    welcome_text: str | None = Field(default=None, max_length=300)
    welcome_channel_id: str | None = None
    banned_words: list[str] | None = Field(default=None, max_length=rules.MAX_BANNED_WORDS)
    soundboard: bool | None = None

    @field_validator("banned_words")
    @classmethod
    def _words(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        seen: dict[str, str] = {}
        for word in v:
            w = rules.normalize_word(word)[:64]
            if w and w not in seen:
                seen[w] = w
        return list(seen)


def community_event(star: Star) -> dict:
    """Всем участникам; список запрещённых слов — только админам (через перезагрузку Звезды)."""
    return {
        "type": "star_community",
        "rules_text": star.rules_text,
        "welcome_text": star.welcome_text,
        "welcome_channel_id": star.welcome_channel_id,
        "soundboard": star.soundboard,
    }


@router.patch("/{star_id}/community", status_code=status.HTTP_204_NO_CONTENT)
async def update_community(star_id: str, body: CommunitySettings, current_user: CurrentUser, db: Db):
    """Меняются только переданные поля; null — очистить."""
    star, _ = await _admin(db, star_id, current_user)
    fields = body.model_fields_set
    rules_changed = False
    if "rules_text" in fields:
        text = (body.rules_text or "").strip() or None
        rules_changed = text != star.rules_text
        star.rules_text = text
    if "welcome_text" in fields:
        star.welcome_text = (body.welcome_text or "").strip() or None
    if "welcome_channel_id" in fields:
        if body.welcome_channel_id:
            ok = (
                await db.execute(
                    select(StarChannel.id).where(
                        StarChannel.id == body.welcome_channel_id,
                        StarChannel.star_id == star_id,
                        StarChannel.kind == "satellite",
                    )
                )
            ).scalar_one_or_none()
            if not ok:
                raise HTTPException(status_code=422, detail="Приветствовать можно только в Спутнике этой Звезды")
        star.welcome_channel_id = body.welcome_channel_id
    if "banned_words" in fields:
        star.banned_words = body.banned_words or []
    if "soundboard" in fields and body.soundboard is not None:
        star.soundboard = body.soundboard
    if rules_changed:
        # Новые правила — согласиться заново.
        await db.execute(
            update(StarMember).where(StarMember.star_id == star_id).values(rules_accepted_at=None)
        )
    await db.commit()
    await _broadcast(db, star_id, community_event(star))
    await star_audit.record(db, star_id, current_user.id, "settings", fields=sorted(fields))


@router.post("/{star_id}/rules/accept", status_code=status.HTTP_204_NO_CONTENT)
async def accept_rules(star_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    me.rules_accepted_at = _now()
    await db.commit()


# --- Свои роли (теги) ----------------------------------------------------------


class TagBody(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    color: str
    self_assign: bool = False
    # Имя для упоминания: «@backend» зовёт всех, у кого эта роль. Пусто — роль не упоминается.
    handle: str | None = Field(default=None, max_length=33)

    @field_validator("handle")
    @classmethod
    def _handle(cls, v: str | None) -> str | None:
        v = (v or "").strip().removeprefix("@")
        if not v:
            return None
        if not HANDLE_RE.fullmatch(v) or v.endswith("."):
            raise ValueError("Имя для упоминания — от 2 до 32 букв, цифр, «_» или «.», без пробелов")
        if v.lower() in notify.RESERVED_WORDS:
            raise ValueError(f"@{v} уже значит «всем» или «кто в сети» — выберите другое имя")
        return v

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Пустое название")
        return v

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        if not COLOR_RE.match(v):
            raise ValueError("Цвет — #RRGGBB")
        return v.lower()


async def _tags_event(db: AsyncSession, star_id: str) -> None:
    tags = (
        await db.execute(select(StarTag).where(StarTag.star_id == star_id).order_by(StarTag.position, StarTag.created_at))
    ).scalars().all()
    await _broadcast(
        db, star_id, {"type": "star_tags", "tags": [StarTagOut.model_validate(t).model_dump() for t in tags]}
    )


async def _check_handle(db: AsyncSession, star_id: str, handle: str | None, tag_id: str | None = None) -> None:
    """Имя группы не совпадает с именем другой группы или ником участника этой Звезды."""
    if not handle:
        return
    key = handle.lower()
    taken = (
        await db.execute(
            select(StarTag.id).where(
                StarTag.star_id == star_id, func.lower(StarTag.handle) == key, StarTag.id != (tag_id or "")
            )
        )
    ).first()
    if taken:
        raise HTTPException(status_code=409, detail=f"@{handle} уже есть у другой роли")
    member = (
        await db.execute(
            select(User.id)
            .join(StarMember, StarMember.user_id == User.id)
            .where(StarMember.star_id == star_id, func.lower(User.username) == key)
        )
    ).first()
    if member:
        raise HTTPException(status_code=409, detail=f"@{handle} — ник участника этой Звезды")


async def _tag(db: AsyncSession, star_id: str, tag_id: str) -> StarTag:
    tag = (
        await db.execute(select(StarTag).where(StarTag.id == tag_id, StarTag.star_id == star_id))
    ).scalar_one_or_none()
    if not tag:
        raise HTTPException(status_code=404, detail="Роль не найдена")
    return tag


@router.post("/{star_id}/tags", response_model=StarTagOut, status_code=status.HTTP_201_CREATED)
async def create_tag(star_id: str, body: TagBody, current_user: CurrentUser, db: Db):
    await _admin(db, star_id, current_user)
    count, top = (
        await db.execute(
            select(func.count(), func.max(StarTag.position)).where(StarTag.star_id == star_id)
        )
    ).one()
    if count >= rules.MAX_TAGS:
        raise HTTPException(status_code=409, detail=f"Не больше {rules.MAX_TAGS} ролей")
    await _check_handle(db, star_id, body.handle)
    tag = StarTag(star_id=star_id, position=(top or 0) + 1, **body.model_dump())
    db.add(tag)
    await db.commit()
    await _tags_event(db, star_id)
    await star_audit.record(db, star_id, current_user.id, "tag", tag.id, op="create", name=tag.name)
    return tag


@router.patch("/{star_id}/tags/{tag_id}", response_model=StarTagOut)
async def update_tag(star_id: str, tag_id: str, body: TagBody, current_user: CurrentUser, db: Db):
    await _admin(db, star_id, current_user)
    tag = await _tag(db, star_id, tag_id)
    # Не прислали handle (старый клиент) — имя для упоминания не трогаем.
    changes = body.model_dump(exclude_unset=True)
    if "handle" in changes:
        await _check_handle(db, star_id, body.handle, tag_id)
    for key, value in changes.items():
        setattr(tag, key, value)
    await db.commit()
    await _tags_event(db, star_id)
    return tag


@router.delete("/{star_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(star_id: str, tag_id: str, current_user: CurrentUser, db: Db):
    await _admin(db, star_id, current_user)
    tag = await _tag(db, star_id, tag_id)
    holders = (
        await db.execute(select(StarMemberTag.user_id).where(StarMemberTag.tag_id == tag_id))
    ).scalars().all()
    name = tag.name
    await db.delete(tag)
    await db.commit()
    await _tags_event(db, star_id)
    for user_id in holders:
        member = (
            await db.execute(
                select(StarMember).where(StarMember.star_id == star_id, StarMember.user_id == user_id)
            )
        ).scalar_one_or_none()
        if member:
            await broadcast_member(db, member)
    await star_audit.record(db, star_id, current_user.id, "tag", tag_id, op="delete", name=name)


async def _assign(star_id: str, user_id: str, tag_id: str, on: bool, current_user: User, db: AsyncSession):
    _, me = await _load_membership(db, star_id, current_user.id)
    tag = await _tag(db, star_id, tag_id)
    target = await _target_member(db, star_id, user_id)
    own_choice = user_id == current_user.id and tag.self_assign
    if not own_choice and me.role not in ("owner", "admin"):
        raise _forbid("Эту роль выдают владелец и админы")
    if on:
        await db.execute(
            insert(StarMemberTag)
            .values(tag_id=tag_id, user_id=user_id, star_id=star_id)
            .on_conflict_do_nothing()
        )
    else:
        await db.execute(
            delete(StarMemberTag).where(StarMemberTag.tag_id == tag_id, StarMemberTag.user_id == user_id)
        )
    await db.commit()
    await broadcast_member(db, target)
    if not own_choice:
        await star_audit.record(
            db, star_id, current_user.id, "tag", user_id, op="give" if on else "take", name=tag.name
        )


@router.put("/{star_id}/members/{user_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def give_tag(star_id: str, user_id: str, tag_id: str, current_user: CurrentUser, db: Db):
    await _assign(star_id, user_id, tag_id, True, current_user, db)


@router.delete("/{star_id}/members/{user_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def take_tag(star_id: str, user_id: str, tag_id: str, current_user: CurrentUser, db: Db):
    await _assign(star_id, user_id, tag_id, False, current_user, db)


# --- Тайм-аут ------------------------------------------------------------------


class TimeoutBody(BaseModel):
    # 5, 60, 1440, 10080 минут; null — снять.
    minutes: int | None

    @field_validator("minutes")
    @classmethod
    def _minutes(cls, v: int | None) -> int | None:
        if v is not None and v not in rules.TIMEOUT_MINUTES:
            raise ValueError("Тайм-аут: 5 минут, час, сутки или неделя")
        return v


@router.post("/{star_id}/members/{user_id}/timeout", status_code=status.HTTP_204_NO_CONTENT)
async def timeout_member(star_id: str, user_id: str, body: TimeoutBody, current_user: CurrentUser, db: Db):
    """Тайм-аут: не пишет в Спутники, не ставит реакции, на Планетах — без микрофона."""
    star, me = await _load_membership(db, star_id, current_user.id)
    target = await _target_member(db, star_id, user_id)
    if not rules.can_timeout(me.role, target.role, star.role_permissions):
        raise _forbid()
    target.timeout_until = _now() + timedelta(minutes=body.minutes) if body.minutes else None
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "timeout", user_id, minutes=body.minutes)
    await broadcast_member(db, target)
    # Кто сейчас на Планете — глушим (или возвращаем микрофон).
    for channel_id in voice.channels_with_user(star_id, user_id):
        try:
            await voice.set_server_muted(star_id, channel_id, user_id, body.minutes is not None)
        except livekit.LiveKitError:
            pass  # голосовой сервер недоступен — при следующем входе токен всё равно без микрофона


# --- Журнал --------------------------------------------------------------------


class AuditOut(BaseModel):
    id: str
    actor: StarUserOut | None
    action: str
    target: StarUserOut | None
    target_id: str | None
    details: dict
    created_at: datetime


@router.get("/{star_id}/audit", response_model=list[AuditOut])
async def list_audit(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    limit: int = Query(50, ge=1, le=100),
    before: datetime | None = Query(None),
):
    await _admin(db, star_id, current_user)
    query = select(StarAudit).where(StarAudit.star_id == star_id)
    if before:
        query = query.where(StarAudit.created_at < before)
    rows = (await db.execute(query.order_by(StarAudit.created_at.desc()).limit(limit))).scalars().all()
    user_ids = {r.actor_id for r in rows if r.actor_id} | {r.target_id for r in rows if r.target_id}
    users = {
        u.id: u for u in (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
    } if user_ids else {}
    return [
        AuditOut(
            id=r.id,
            actor=_user_out(users[r.actor_id]) if r.actor_id in users else None,
            action=r.action,
            target=_user_out(users[r.target_id]) if r.target_id in users else None,
            target_id=r.target_id,
            details=r.details or {},
            created_at=r.created_at,
        )
        for r in rows
    ]

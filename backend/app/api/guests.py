"""Гостевые ссылки: человек без аккаунта заходит по ссылке в одну комнату рабочей Звезды.

Гость видит только эту комнату — ни Спутников, ни участников Звезды, ни других комнат. Говорит
(если комната не «только слушать»), главным в комнате не становится. Ссылка живёт до срока
или пока её не отзовут; отзыв выводит из комнаты и тех гостей, что уже внутри.

Открыл ссылку под своим аккаунтом — получает пропуск (StarRoomPass) на срок ссылки: Комната видна
ему в приложении и пускает без стука. Участнику без доступа к этажу — этаж с одной этой Комнатой,
тому, кто не в Звезде, — Звезда с одной этой Комнатой. Ссылка кончилась или её отозвали — пропуск
пропадает, а сам человек выходит из Комнаты.
"""

import secrets
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.doors import GATHERING, INVITE, PERSONAL, can_admit, door, gathering_admin
from app.api.stars import _channel, _is_superuser, _load_membership, assert_room_access, passes_changed
from app.core import floors as floors_svc
from app.core import livekit, voice
from app.core import stars as rules
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import Star, StarBan, StarChannel, StarGuestLink, StarMember, StarRoomPass
from app.models.user import User
from app.ws.hub import manager

router = APIRouter(prefix="/stars", tags=["guests"])
public_router = APIRouter(prefix="/guest", tags=["guests"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

MAX_HOURS = 24 * 7
JOIN_RATE = 20  # входов в минуту по одной ссылке
_joins: dict[str, deque[float]] = defaultdict(deque)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def can_invite_guests(star: Star, member: StarMember, channel: StarChannel) -> bool:
    """Кто может звать гостей: в открытую комнату — кто может приглашать в Звезду,
    в «по приглашениям» — главный и те, кто впускает, в кабинет — хозяин, админы, владелец,
    в комнату сбора — организаторы сбора и те, кто впускает."""
    kind = door(channel)
    if kind == PERSONAL:
        return member.user_id == channel.cabinet_owner_id or member.role in ("owner", "admin")
    if kind == INVITE:
        return voice.host(channel.id) == member.user_id or can_admit(star, member)
    if kind == GATHERING:
        return gathering_admin(member.user_id, channel) or can_admit(star, member)
    return rules.has_perm(member.role, Perm.INVITE, star.role_permissions)


class GuestLinkOut(BaseModel):
    id: str
    code: str
    channel_id: str
    created_by: str | None
    created_at: datetime
    expires_at: datetime
    uses: int

    model_config = {"from_attributes": True}


class CreateGuestLink(BaseModel):
    hours: int = Field(default=24, ge=1, le=MAX_HOURS)


@router.post("/{star_id}/planets/{channel_id}/guest-links", response_model=GuestLinkOut, status_code=201)
async def create_guest_link(star_id: str, channel_id: str, body: CreateGuestLink, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    if star.kind != "work" or channel.kind != "planet" or channel.room_kind == "lobby":
        raise HTTPException(status_code=400, detail="Гостей зовут в комнаты рабочей Звезды")
    await assert_room_access(db, star, me, channel)
    if not can_invite_guests(star, me, channel):
        raise HTTPException(status_code=403, detail="Звать гостей сюда может тот, кто впускает в эту комнату")
    link = StarGuestLink(
        code=secrets.token_urlsafe(12),
        star_id=star_id,
        channel_id=channel_id,
        created_by=current_user.id,
        expires_at=_now() + timedelta(hours=body.hours),
    )
    db.add(link)
    await db.commit()
    return link


@router.get("/{star_id}/planets/{channel_id}/guest-links", response_model=list[GuestLinkOut])
async def list_guest_links(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    """Действующие ссылки в комнату — тем, кто может звать гостей."""
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    if not can_invite_guests(star, me, channel) or not await floors_svc.can_use_room(db, star, me, channel):
        return []
    rows = await db.execute(
        select(StarGuestLink)
        .where(StarGuestLink.channel_id == channel_id, StarGuestLink.revoked.is_(False), StarGuestLink.expires_at > _now())
        .order_by(StarGuestLink.created_at.desc())
    )
    return list(rows.scalars())


@router.delete("/{star_id}/guest-links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_guest_link(star_id: str, link_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    link = (
        await db.execute(select(StarGuestLink).where(StarGuestLink.id == link_id, StarGuestLink.star_id == star_id))
    ).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Ссылка не найдена")
    channel = await _channel(db, star_id, link.channel_id)
    if link.created_by != current_user.id and not can_invite_guests(star, me, channel):
        raise HTTPException(status_code=403, detail="Отозвать может автор ссылки или тот, кто впускает в комнату")
    link.revoked = True
    await db.commit()
    # Кто уже внутри по этой ссылке — выходит.
    prefix = f"{voice.GUEST_PREFIX}{link.id}-"
    for p in voice.participants(link.channel_id):
        if p.user_id.startswith(prefix):
            await voice.remove_from_planet(star_id, link.channel_id, p.user_id)
    # И те, кто открыл её под своим аккаунтом.
    await release_passes(db, list((await db.execute(select(StarRoomPass).where(StarRoomPass.link_id == link.id))).scalars()))


async def release_passes(db: AsyncSession, passes: list[StarRoomPass]) -> None:
    """Пропуска по ссылкам, которые кончились или отозваны: убрать и сказать их владельцам."""
    if not passes:
        return
    by_star: dict[str, set[str]] = defaultdict(set)
    for p in passes:
        by_star[p.star_id].add(p.user_id)
    await db.execute(delete(StarRoomPass).where(StarRoomPass.id.in_([p.id for p in passes])))
    await db.commit()
    for star_id, user_ids in by_star.items():
        star = await db.get(Star, star_id)
        if star:
            await passes_changed(db, star, user_ids)


async def expire_room_passes(db: AsyncSession) -> int:
    """Фоновая задача: пропуска по истёкшим и отозванным ссылкам."""
    rows = list(
        (
            await db.execute(
                select(StarRoomPass)
                .join(StarGuestLink, StarGuestLink.id == StarRoomPass.link_id)
                .where(or_(StarGuestLink.revoked.is_(True), StarGuestLink.expires_at <= _now()))
            )
        ).scalars()
    )
    await release_passes(db, rows)
    return len(rows)


# --- Гость --------------------------------------------------------------------------


class GuestInfoOut(BaseModel):
    star_name: str
    room_name: str
    expires_at: datetime
    listen_only: bool


class GuestJoinIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class GuestJoinOut(BaseModel):
    url: str
    token: str
    room: str
    identity: str
    room_name: str
    star_name: str


async def _active_link(db: AsyncSession, code: str) -> tuple[StarGuestLink, Star, StarChannel]:
    link = (await db.execute(select(StarGuestLink).where(StarGuestLink.code == code))).scalar_one_or_none()
    if not link or link.revoked or link.expires_at <= _now():
        raise HTTPException(status_code=404, detail="Ссылка недействительна: срок истёк или её отозвали")
    star = await db.get(Star, link.star_id)
    channel = await db.get(StarChannel, link.channel_id)
    if not star or not channel:
        raise HTTPException(status_code=404, detail="Комнаты больше нет")
    return link, star, channel


@public_router.get("/{code}", response_model=GuestInfoOut)
async def guest_info(code: str, db: Db):
    link, star, channel = await _active_link(db, code)
    return GuestInfoOut(star_name=star.name, room_name=channel.name, expires_at=link.expires_at, listen_only=channel.listen_only)


class GuestClaimOut(BaseModel):
    star_id: str
    channel_id: str
    floor_id: str | None
    expires_at: datetime


@public_router.post("/{code}/claim", response_model=GuestClaimOut)
async def claim_guest_link(code: str, current_user: CurrentUser, db: Db):
    """Открыть ссылку под своим аккаунтом: Комната появится в приложении, пока ссылка действует."""
    link, star, channel = await _active_link(db, code)
    banned = (
        await db.execute(select(StarBan.id).where(StarBan.star_id == star.id, StarBan.user_id == current_user.id))
    ).first()
    if banned:
        raise HTTPException(status_code=403, detail="Вас заблокировали в этой Звезде")
    member = (
        await db.execute(select(StarMember).where(StarMember.star_id == star.id, StarMember.user_id == current_user.id))
    ).scalar_one_or_none()
    # Кому Комната и так открыта, пропуск не нужен.
    sees = await _is_superuser(db, current_user.id) or (
        member is not None and await floors_svc.can_use_room(db, star, member, channel)
    )
    if not sees:
        added = await db.execute(
            pg_insert(StarRoomPass)
            .values(id=str(uuid.uuid4()), link_id=link.id, user_id=current_user.id, star_id=star.id, channel_id=channel.id)
            .on_conflict_do_nothing(constraint="uq_star_room_pass")
        )
        await db.commit()
        if added.rowcount:
            # Другие устройства этого человека тоже перечитают Звезду (или впервые её получат).
            await manager.send_to_user(current_user.id, {"type": "star_floor_access", "star_id": star.id})
    return GuestClaimOut(star_id=star.id, channel_id=channel.id, floor_id=channel.floor_id, expires_at=link.expires_at)


@public_router.post("/{code}/join", response_model=GuestJoinOut)
async def guest_join(code: str, body: GuestJoinIn, request: Request, db: Db):
    link, star, channel = await _active_link(db, code)
    name = " ".join(body.name.split())
    if not name:
        raise HTTPException(status_code=422, detail="Представьтесь")
    now = time.monotonic()
    recent = _joins[link.id]
    while recent and now - recent[0] > 60:
        recent.popleft()
    if len(recent) >= JOIN_RATE:
        raise HTTPException(status_code=429, detail="Слишком много входов — подождите минуту")
    recent.append(now)
    if not livekit.configured():
        raise HTTPException(status_code=503, detail="Голосовая связь пока не настроена на сервере")

    room = voice.room_name(channel.id)
    capacity = channel.capacity or rules.DEFAULT_PLANET_CAPACITY
    try:
        await livekit.room_service.create_room(room, max_participants=rules.PLANET_MAX_CAPACITY)
        present = await livekit.room_service.list_participants(room)
    except livekit.LiveKitError as exc:
        raise HTTPException(status_code=503, detail="Голосовой сервер сейчас недоступен") from exc
    if len(present) >= capacity:
        raise HTTPException(status_code=409, detail=f"Комната заполнена: {len(present)} из {capacity}")

    identity = f"{voice.GUEST_PREFIX}{link.id}-{secrets.token_hex(4)}"
    link.uses += 1
    await db.commit()
    token = livekit.participant_token(
        room=room,
        identity=identity,
        name=f"{name} (гость)",
        metadata={"star_id": star.id, "channel_id": channel.id, "guest": True},
        sources=() if channel.listen_only else (livekit.SOURCE_MICROPHONE,),
    )
    return GuestJoinOut(
        url=settings.LIVEKIT_PUBLIC_URL, token=token, room=room, identity=identity,
        room_name=channel.name, star_name=star.name,
    )

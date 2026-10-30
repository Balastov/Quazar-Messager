"""Созвездие: Звёзды, участники и роли, приглашения, Спутники и Планеты, сообщения Спутников.

Все лимиты и права проверяются здесь, на сервере; правила — в app.core.stars.
"""

import secrets
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import stars as rules
from app.core.avatars import MAX_AVATAR_BYTES, delete_star_avatar_files, detect_image, save_star_avatar
from app.core.backgrounds import (
    MAX_BACKGROUND_BYTES,
    BackgroundRejected,
    check_background,
    delete_background,
    save_background,
)
from app.core import doors
from app.core import markup, notify, presence, revisions, shares, star_assets, star_audit, star_files
from app.core import floors as floors_svc
from app.core import voice
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import (
    Star,
    StarBan,
    StarChannel,
    StarChannelShare,
    StarFile,
    StarInvite,
    StarMember,
    StarMemberTag,
    StarMessage,
    StarMessageAck,
    StarMessageReaction,
    StarMessageRevision,
    StarTag,
)
from app.models.user import User
from app.schemas.star import (
    CreateChannel,
    CreateInvite,
    CreateStar,
    EditStarMessage,
    InvitePreviewOut,
    ReorderChannels,
    SendStarMessage,
    SetStarReaction,
    StarBanOut,
    SharedStarOut,
    StarChannelOut,
    StarDetailOut,
    StarFileOut,
    StarFloorOut,
    StarInviteOut,
    StarLimitsOut,
    StarMemberOut,
    StarMessageOut,
    StarReactionOut,
    StarReplyOut,
    StarSummaryOut,
    StarTagOut,
    StarUserOut,
    TransferStar,
    UpdateChannel,
    UpdateMemberRole,
    UpdateRolePermissions,
    UpdateStar,
)
from app.ws.hub import manager

router = APIRouter(prefix="/stars", tags=["stars"])
invites_router = APIRouter(prefix="/star-invites", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


# --- Вспомогательное ------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _forbid(detail: str = "Недостаточно прав") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def _user_out(user: User) -> StarUserOut:
    return StarUserOut(
        id=user.id, username=user.username, display_name=user.display_name, avatar_url=user.avatar_url
    )


async def _load_membership(db: AsyncSession, star_id: str, user_id: str) -> tuple[Star, StarMember]:
    """Звезда и участие текущего пользователя. Чужим Звёздам — 404, чтобы не раскрывать их.

    Владелец ресурса в любой Звезде действует как её владелец — и там, где он не участник
    (тогда для остальных его как бы нет: в списке участников он не появляется). Его участие
    подменяется копией с ролью owner, в базу она не попадает.
    """
    row = (
        await db.execute(
            select(Star, StarMember)
            .join(StarMember, StarMember.star_id == Star.id)
            .where(Star.id == star_id, StarMember.user_id == user_id)
        )
    ).first()
    if await _is_superuser(db, user_id):
        star = row[0] if row else await db.get(Star, star_id)
        if not star:
            raise HTTPException(status_code=404, detail="Звезда не найдена")
        real = row[1] if row else None
        return star, StarMember(
            star_id=star.id,
            user_id=user_id,
            role="owner",
            joined_at=real.joined_at if real else _now(),
            rules_accepted_at=_now(),
        )
    if not row:
        raise HTTPException(status_code=404, detail="Звезда не найдена")
    return row[0], row[1]


async def _is_superuser(db: AsyncSession, user_id: str) -> bool:
    return bool((await db.execute(select(User.is_superuser).where(User.id == user_id))).scalar_one_or_none())


async def _require_perm(db: AsyncSession, star_id: str, user: User, perm: Perm) -> tuple[Star, StarMember]:
    star, me = await _load_membership(db, star_id, user.id)
    if not rules.has_perm(me.role, perm, star.role_permissions):
        raise _forbid()
    return star, me


async def _target_member(db: AsyncSession, star_id: str, user_id: str) -> StarMember:
    member = (
        await db.execute(
            select(StarMember).where(StarMember.star_id == star_id, StarMember.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=404, detail="Участник не найден")
    return member


async def _member_ids(db: AsyncSession, star_id: str) -> list[str]:
    result = await db.execute(select(StarMember.user_id).where(StarMember.star_id == star_id))
    return [row[0] for row in result.all()]


async def _member_count(db: AsyncSession, star_id: str) -> int:
    return (
        await db.execute(select(func.count()).select_from(StarMember).where(StarMember.star_id == star_id))
    ).scalar_one()


async def _owned_count(db: AsyncSession, user_id: str) -> int:
    return (
        await db.execute(select(func.count()).select_from(Star).where(Star.owner_id == user_id))
    ).scalar_one()


async def _lock_user(db: AsyncSession, user_id: str) -> User:
    """Блокировка строки пользователя: лимит «2 Звезды» не обойти параллельными запросами."""
    user = (
        await db.execute(select(User).where(User.id == user_id).with_for_update())
    ).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    return user


def _event_channel_id(event: dict) -> str | None:
    """Канал, к которому относится событие (для общих Спутников — кому ещё его слать)."""
    if isinstance(event.get("channel_id"), str):
        return event["channel_id"]
    for key, field in (("message", "channel_id"), ("channel", "id")):
        nested = event.get(key)
        if isinstance(nested, dict) and isinstance(nested.get(field), str):
            return nested[field]
    return None


async def _broadcast(db: AsyncSession, star_id: str, event: dict, *, also: tuple[str, ...] = ()) -> None:
    """Участникам Звезды. Событие общего Спутника — участникам всех подключённых Звёзд,
    каждому со star_id его Звезды; кто состоит в нескольких — получает один раз."""
    channel_id = _event_channel_id(event)
    star_ids = await shares.audience_star_ids(db, channel_id, star_id) if channel_id else [star_id]
    if len(star_ids) == 1:
        user_ids = set(await _member_ids(db, star_id)) | set(also)
        await manager.broadcast_to_users(list(user_ids), {"star_id": star_id, **event})
        return
    known = set(star_ids)
    sent: set[str] = set()
    for i, sid in enumerate(star_ids):
        user_ids = set(await _member_ids(db, sid)) - sent
        if i == 0:
            user_ids |= set(also) - sent
        if not user_ids:
            continue
        sent |= user_ids
        await manager.broadcast_to_users(list(user_ids), shares.for_star({"star_id": star_id, **event}, known, sid))


def _staff_here(me: StarMember, channel: StarChannel) -> bool:
    """Модератор в этом канале: в общем Спутнике — только у Звезды-хозяина, гости там — участники."""
    return rules.is_staff(me.role) and me.star_id == channel.star_id


def _as_star(outs: list[StarMessageOut], star_id: str) -> list[StarMessageOut]:
    """Сообщения общего Спутника гостевой Звезде — с её star_id (клиент ходит по своим адресам)."""
    for out in outs:
        out.star_id = star_id
    return outs


async def _member_tag_ids(db: AsyncSession, star_id: str, user_id: str | None = None) -> dict[str, list[str]]:
    query = select(StarMemberTag.user_id, StarMemberTag.tag_id).where(StarMemberTag.star_id == star_id)
    if user_id:
        query = query.where(StarMemberTag.user_id == user_id)
    by_user: dict[str, list[str]] = defaultdict(list)
    for uid, tag_id in (await db.execute(query)).all():
        by_user[uid].append(tag_id)
    return by_user


def _active_timeout(member: StarMember) -> datetime | None:
    return member.timeout_until if member.timeout_until and member.timeout_until > _now() else None


async def _work_hours_on(db: AsyncSession, star_id: str) -> bool:
    return bool((await db.execute(select(Star.work_hours_enabled).where(Star.id == star_id))).scalar_one_or_none())


async def _members_out(db: AsyncSession, star_id: str) -> list[StarMemberOut]:
    rows = (
        await db.execute(
            select(StarMember, User)
            .join(User, User.id == StarMember.user_id)
            .where(StarMember.star_id == star_id)
        )
    ).all()
    tags = await _member_tag_ids(db, star_id)
    schedules = await _work_hours_on(db, star_id)
    members = [
        StarMemberOut(
            user=_user_out(user),
            role=m.role,
            joined_at=m.joined_at,
            tag_ids=tags.get(user.id, []),
            timeout_until=_active_timeout(m),
            work_schedule=user.work_schedule if schedules else None,
        )
        for m, user in rows
    ]
    members.sort(key=lambda m: (-rules.rank(m.role), m.joined_at))
    return members


async def _member_out(db: AsyncSession, member: StarMember) -> StarMemberOut:
    user = (await db.execute(select(User).where(User.id == member.user_id))).scalar_one()
    tags = await _member_tag_ids(db, member.star_id, member.user_id)
    return StarMemberOut(
        user=_user_out(user),
        role=member.role,
        joined_at=member.joined_at,
        tag_ids=tags.get(member.user_id, []),
        timeout_until=_active_timeout(member),
        work_schedule=user.work_schedule if await _work_hours_on(db, member.star_id) else None,
    )


async def broadcast_member(db: AsyncSession, member: StarMember) -> StarMemberOut:
    """Участник изменился (роль, теги, тайм-аут) — всем свежая карточка."""
    out = await _member_out(db, member)
    await _broadcast(db, member.star_id, {"type": "star_member_upsert", "member": out.model_dump(mode="json")})
    return out


async def _channels(db: AsyncSession, star_id: str) -> list[StarChannel]:
    result = await db.execute(
        select(StarChannel)
        .where(StarChannel.star_id == star_id)
        .order_by(StarChannel.kind.desc(), StarChannel.position, StarChannel.created_at)
    )
    return list(result.scalars().all())


def _summary(star: Star, my_role: str, member_count: int) -> StarSummaryOut:
    return StarSummaryOut(
        id=star.id,
        name=star.name,
        kind=star.kind,
        owner_id=star.owner_id,
        avatar_url=star.avatar_url,
        background_url=star.background_url,
        created_at=star.created_at,
        member_count=member_count,
        my_role=my_role,
    )


def _star_updated(star: Star) -> dict:
    return {
        "type": "star_updated",
        "name": star.name,
        "owner_id": star.owner_id,
        "avatar_url": star.avatar_url,
        "background_url": star.background_url,
    }


def floors_event(floors: list) -> dict:
    return {
        "type": "star_floors",
        "floors": [StarFloorOut.model_validate(f).model_dump(mode="json") for f in floors],
    }


async def _detail(db: AsyncSession, star: Star, me: StarMember) -> StarDetailOut:
    # Рабочим Звёздам — этаж и места для комнат (в т.ч. созданным до появления карты).
    floors = await floors_svc.ensure_floors(db, star)
    members = await _members_out(db, star.id)
    channels = await channels_out(db, star.id)
    tags = (
        await db.execute(select(StarTag).where(StarTag.star_id == star.id).order_by(StarTag.position, StarTag.created_at))
    ).scalars().all()
    return StarDetailOut(
        **_summary(star, me.role, len(members)).model_dump(),
        my_permissions=rules.effective_permissions(me.role, star.role_permissions),
        role_permissions=rules.normalize_role_permissions(star.role_permissions),
        channels=channels,
        members=members,
        voice=voice.star_presence(star.id),
        voice_since=voice.star_active_since(star.id),
        floors=[StarFloorOut.model_validate(f) for f in floors],
        rules_text=star.rules_text,
        rules_accepted=_rules_ok(star, me),
        welcome_text=star.welcome_text,
        welcome_channel_id=star.welcome_channel_id,
        soundboard=star.soundboard,
        banned_words=list(star.banned_words or []) if me.role in ("owner", "admin") else [],
        tags=[StarTagOut.model_validate(t) for t in tags],
        work_hours_enabled=star.work_hours_enabled,
        work_hours=star.work_hours,
    )


async def channels_out(db: AsyncSession, star_id: str) -> list[StarChannelOut]:
    """Каналы Звезды и подключённые к ней общие Спутники (после своих)."""
    own = await _channels(db, star_id)
    guests = await shares.shared_into(db, star_id)
    links = (
        await db.execute(
            select(StarChannelShare.channel_id, Star)
            .join(Star, Star.id == StarChannelShare.star_id)
            .where(StarChannelShare.channel_id.in_([c.id for c in own if c.kind == "satellite"]))
            .order_by(StarChannelShare.created_at)
        )
    ).all() if own else []
    homes = {
        s.id: s
        for s in (await db.execute(select(Star).where(Star.id.in_({c.star_id for c in guests})))).scalars()
    } if guests else {}
    shared_with: dict[str, list[SharedStarOut]] = {}
    for channel_id, other in links:
        shared_with.setdefault(channel_id, []).append(_shared_star(other))
    out = []
    for c in own:
        item = StarChannelOut.model_validate(c)
        item.shared_with = shared_with.get(c.id, [])
        out.append(item)
    for c in guests:
        item = StarChannelOut.model_validate(c)
        item.star_id = star_id
        item.position = 10_000 + item.position
        home = homes.get(c.star_id)
        item.shared_from = _shared_star(home) if home else None
        out.append(item)
    return out


def _shared_star(star: Star) -> SharedStarOut:
    return SharedStarOut(id=star.id, name=star.name, avatar_url=star.avatar_url)


def _rules_ok(star: Star, me: StarMember) -> bool:
    return not star.rules_text or rules.is_staff(me.role) or me.rules_accepted_at is not None


def assert_can_post(star: Star, me: StarMember) -> None:
    """Писать в Спутники и ставить реакции: не в тайм-ауте и с принятыми правилами."""
    until = _active_timeout(me)
    if until:
        raise _forbid(f"Вы в тайм-ауте до {until.astimezone().strftime('%d.%m %H:%M')}")
    if not _rules_ok(star, me):
        raise _forbid("Сначала примите правила Звезды")


def assert_clean_text(star: Star, me: StarMember, text: str) -> None:
    if rules.bypasses_word_filter(me.role):
        return
    if rules.find_banned_word(text, star.banned_words):
        raise HTTPException(status_code=422, detail="В сообщении есть запрещённое в этой Звезде слово")


async def _remove_member(db: AsyncSession, star_id: str, user_id: str, reason: str) -> None:
    """Удаляет участника и сообщает: ему — что он больше не в Звезде, остальным — что ушёл."""
    await db.execute(
        delete(StarMember).where(StarMember.star_id == star_id, StarMember.user_id == user_id)
    )
    await db.commit()
    await _broadcast(db, star_id, {"type": "star_member_removed", "user_id": user_id, "reason": reason})
    await manager.send_to_user(user_id, {"type": "star_removed", "star_id": star_id, "reason": reason})
    doors.forget_user(star_id, user_id)
    await voice.evict_user(star_id, user_id)


def _default_channels(star: Star) -> list[StarChannel]:
    if star.kind == "work":
        planets = [
            StarChannel(
                star_id=star.id,
                kind="planet",
                name="Коворкинг",
                position=0,
                room_kind="coworking",
                capacity=rules.default_capacity("coworking"),
            ),
            StarChannel(
                star_id=star.id,
                kind="planet",
                name="Переговорная",
                position=1,
                room_kind="meeting",
                capacity=rules.default_capacity("meeting"),
            ),
        ]
    else:
        planets = [
            StarChannel(
                star_id=star.id,
                kind="planet",
                name="Общая",
                position=0,
                capacity=rules.DEFAULT_PLANET_CAPACITY,
            )
        ]
    return [StarChannel(star_id=star.id, kind="satellite", name="общий", position=0), *planets]


# --- Звёзды ---------------------------------------------------------------


@router.get("/limits", response_model=StarLimitsOut)
async def get_limits(current_user: CurrentUser, db: Db):
    return StarLimitsOut(
        max_owned_stars=rules.MAX_OWNED_STARS,
        owned_stars=await _owned_count(db, current_user.id),
        max_star_members=rules.MAX_STAR_MEMBERS,
        gaming_max_satellites=rules.GAMING_MAX_SATELLITES,
        gaming_max_planets=rules.GAMING_MAX_PLANETS,
        planet_max_capacity=rules.PLANET_MAX_CAPACITY,
        room_kinds=rules.ROOM_KINDS,
    )


@router.get("", response_model=list[StarSummaryOut])
async def list_stars(current_user: CurrentUser, db: Db):
    counts = (
        select(StarMember.star_id, func.count().label("n"))
        .group_by(StarMember.star_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(Star, StarMember.role, counts.c.n)
            .join(StarMember, StarMember.star_id == Star.id)
            .join(counts, counts.c.star_id == Star.id)
            .where(StarMember.user_id == current_user.id)
            .order_by(StarMember.joined_at)
        )
    ).all()
    return [_summary(star, role, n) for star, role, n in rows]


@router.post("", response_model=StarDetailOut, status_code=status.HTTP_201_CREATED)
async def create_star(body: CreateStar, current_user: CurrentUser, db: Db):
    await _lock_user(db, current_user.id)
    if not current_user.is_superuser and await _owned_count(db, current_user.id) >= rules.MAX_OWNED_STARS:
        raise HTTPException(
            status_code=409,
            detail=f"Можно создать не больше {rules.MAX_OWNED_STARS} Звёзд. "
            "Удалите или передайте одну из своих.",
        )

    star = Star(
        name=body.name,
        kind=body.kind,
        owner_id=current_user.id,
        role_permissions=rules.stored_role_permissions(None),
    )
    db.add(star)
    await db.flush()
    me = StarMember(star_id=star.id, user_id=current_user.id, role="owner")
    db.add(me)
    db.add_all(_default_channels(star))
    await db.flush()
    await floors_svc.ensure_floors(db, star)  # «1 этаж» и места для комнат
    await db.commit()
    return await _detail(db, star, me)


@router.get("/{star_id}", response_model=StarDetailOut)
async def get_star(star_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    return await _detail(db, star, me)


@router.patch("/{star_id}", response_model=StarDetailOut)
async def update_star(star_id: str, body: UpdateStar, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid()
    star.name = body.name
    await db.commit()
    await _broadcast(db, star_id, _star_updated(star))
    return await _detail(db, star, me)


@router.post("/{star_id}/avatar", response_model=StarDetailOut)
async def upload_star_avatar(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File(...)],
):
    """Аватар Звезды (JPEG/PNG/WebP/GIF, до 3 МБ) — владелец и админы."""
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid("Аватар Звезды меняют только владелец и админы")
    data = await file.read(MAX_AVATAR_BYTES + 1)
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Картинка должна быть не больше 3 МБ")
    detected = detect_image(data)
    if not detected:
        raise HTTPException(status_code=422, detail="Подойдёт картинка JPEG, PNG, WebP или GIF")
    star.avatar_url = save_star_avatar(star.id, data, detected[1])
    await db.commit()
    await _broadcast(db, star_id, _star_updated(star))
    return await _detail(db, star, me)


@router.delete("/{star_id}/avatar", response_model=StarDetailOut)
async def remove_star_avatar(star_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid("Аватар Звезды меняют только владелец и админы")
    delete_star_avatar_files(star.id)
    star.avatar_url = None
    await db.commit()
    await _broadcast(db, star_id, _star_updated(star))
    return await _detail(db, star, me)


@router.post("/{star_id}/background", response_model=StarDetailOut)
async def upload_star_background(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File(...)],
):
    """Фон Звезды для всех участников (JPEG/PNG/WebP/GIF, до 5 МБ) — владелец и админы."""
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid("Фон Звезды меняют только владелец и админы")
    data = await file.read(MAX_BACKGROUND_BYTES + 1)
    try:
        ext = check_background(data)
    except BackgroundRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None
    old = star.background_url
    star.background_url = save_background(data, ext)
    await db.commit()
    delete_background(old)
    await _broadcast(db, star_id, _star_updated(star))
    return await _detail(db, star, me)


@router.delete("/{star_id}/background", response_model=StarDetailOut)
async def remove_star_background(star_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid("Фон Звезды меняют только владелец и админы")
    old = star.background_url
    star.background_url = None
    await db.commit()
    delete_background(old)
    await _broadcast(db, star_id, _star_updated(star))
    return await _detail(db, star, me)


@router.delete("/{star_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_star(star_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role != "owner":
        raise _forbid("Удалить Звезду может только владелец")
    member_ids = await _member_ids(db, star_id)
    planet_ids = [c.id for c in await _channels(db, star_id) if c.kind == "planet"]
    background = star.background_url
    await db.execute(delete(Star).where(Star.id == star_id))
    await db.commit()
    delete_star_avatar_files(star_id)
    delete_background(background)
    star_assets.delete_star(star_id)
    await manager.broadcast_to_users(
        member_ids, {"type": "star_removed", "star_id": star_id, "reason": "deleted"}
    )
    for channel_id in planet_ids:
        await voice.close_planet(star_id, channel_id)


@router.post("/{star_id}/transfer", response_model=StarDetailOut)
async def transfer_star(star_id: str, body: TransferStar, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role != "owner":
        raise _forbid("Передать Звезду может только владелец")
    if body.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Звезда уже ваша")
    target = await _target_member(db, star_id, body.user_id)

    await _lock_user(db, body.user_id)
    if not await _is_superuser(db, body.user_id) and await _owned_count(db, body.user_id) >= rules.MAX_OWNED_STARS:
        raise HTTPException(
            status_code=409,
            detail=f"У этого участника уже {rules.MAX_OWNED_STARS} своих Звезды — передать нельзя.",
        )

    # Прежний владелец — админом (владелец ресурса может передать и чужую Звезду).
    previous = (
        await db.execute(select(StarMember).where(StarMember.star_id == star_id, StarMember.user_id == star.owner_id))
    ).scalar_one_or_none()
    star.owner_id = body.user_id
    target.role = "owner"
    if previous:
        previous.role = "admin"
    await db.commit()

    for member in (target, previous):
        if not member:
            continue
        await _broadcast(
            db, star_id, {"type": "star_member_upsert", "member": (await _member_out(db, member)).model_dump(mode="json")}
        )
    await _broadcast(db, star_id, _star_updated(star))
    return await _detail(db, star, me)


@router.post("/{star_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_star(star_id: str, current_user: CurrentUser, db: Db):
    star, _ = await _load_membership(db, star_id, current_user.id)
    # Настоящая роль (у владельца ресурса в _load_membership она всегда owner).
    real = (
        await db.execute(
            select(StarMember.role).where(StarMember.star_id == star_id, StarMember.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if real is None:
        raise HTTPException(status_code=400, detail="Вы не участник этой Звезды")
    if real == "owner":
        raise HTTPException(
            status_code=400, detail="Владелец не может выйти: передайте Звезду или удалите её."
        )
    await _remove_member(db, star_id, current_user.id, "leave")


# --- Участники, роли, права -----------------------------------------------


@router.patch("/{star_id}/members/{user_id}", response_model=StarMemberOut)
async def update_member_role(
    star_id: str, user_id: str, body: UpdateMemberRole, current_user: CurrentUser, db: Db
):
    _, me = await _load_membership(db, star_id, current_user.id)
    target = await _target_member(db, star_id, user_id)
    if not rules.can_set_role(me.role, target.role, body.role):
        raise _forbid()
    previous = target.role
    target.role = body.role
    await db.commit()
    out = await broadcast_member(db, target)
    await star_audit.record(db, star_id, current_user.id, "role", user_id, before=previous, after=body.role)
    return out


@router.post("/{star_id}/members/{user_id}/kick", status_code=status.HTTP_204_NO_CONTENT)
async def kick_member(star_id: str, user_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    target = await _target_member(db, star_id, user_id)
    if not rules.can_kick(me.role, target.role, star.role_permissions):
        raise _forbid()
    await _remove_member(db, star_id, user_id, "kick")
    await star_audit.record(db, star_id, current_user.id, "kick", user_id)


@router.post("/{star_id}/members/{user_id}/ban", status_code=status.HTTP_204_NO_CONTENT)
async def ban_member(star_id: str, user_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    target = await _target_member(db, star_id, user_id)
    if not rules.can_ban(me.role, target.role):
        raise _forbid("Блокировать могут только владелец и админы")
    db.add(StarBan(star_id=star_id, user_id=user_id, banned_by=current_user.id))
    await _remove_member(db, star_id, user_id, "ban")
    await star_audit.record(db, star_id, current_user.id, "ban", user_id)


@router.get("/{star_id}/bans", response_model=list[StarBanOut])
async def list_bans(star_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid()
    rows = (
        await db.execute(
            select(StarBan, User)
            .join(User, User.id == StarBan.user_id)
            .where(StarBan.star_id == star_id)
            .order_by(StarBan.created_at.desc())
        )
    ).all()
    return [StarBanOut(user=_user_out(u), banned_by=b.banned_by, created_at=b.created_at) for b, u in rows]


@router.delete("/{star_id}/bans/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unban(star_id: str, user_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid()
    await db.execute(delete(StarBan).where(StarBan.star_id == star_id, StarBan.user_id == user_id))
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "unban", user_id)


@router.put("/{star_id}/permissions", response_model=dict[str, list[str]])
async def update_permissions(
    star_id: str, body: UpdateRolePermissions, current_user: CurrentUser, db: Db
):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role != "owner":
        raise _forbid("Права настраивает владелец")
    star.role_permissions = rules.stored_role_permissions(body.model_dump())
    await db.commit()
    normalized = rules.normalize_role_permissions(star.role_permissions)
    await _broadcast(db, star_id, {"type": "star_permissions", "role_permissions": normalized})
    await star_audit.record(db, star_id, current_user.id, "permissions")
    return normalized


# --- Приглашения ----------------------------------------------------------


def _invite_usable(invite: StarInvite) -> bool:
    if invite.expires_at is not None and invite.expires_at <= _now():
        return False
    return invite.max_uses is None or invite.uses < invite.max_uses


@router.post("/{star_id}/invites", response_model=StarInviteOut, status_code=status.HTTP_201_CREATED)
async def create_invite(star_id: str, body: CreateInvite, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.INVITE)
    invite = StarInvite(
        code=secrets.token_urlsafe(9),
        star_id=star_id,
        created_by=current_user.id,
        expires_at=_now() + timedelta(hours=body.expires_in_hours) if body.expires_in_hours else None,
        max_uses=body.max_uses,
    )
    db.add(invite)
    await db.commit()
    return invite


@router.get("/{star_id}/invites", response_model=list[StarInviteOut])
async def list_invites(star_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.INVITE)
    invites = (
        await db.execute(
            select(StarInvite).where(StarInvite.star_id == star_id).order_by(StarInvite.created_at.desc())
        )
    ).scalars()
    return [i for i in invites if _invite_usable(i)]


@router.delete("/{star_id}/invites/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(star_id: str, code: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    invite = (
        await db.execute(select(StarInvite).where(StarInvite.code == code, StarInvite.star_id == star_id))
    ).scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404, detail="Приглашение не найдено")
    if invite.created_by != current_user.id and me.role not in ("owner", "admin"):
        raise _forbid()
    await db.delete(invite)
    await db.commit()


async def _usable_invite(db: AsyncSession, code: str, *, lock: bool = False) -> StarInvite:
    query = select(StarInvite).where(StarInvite.code == code)
    if lock:
        query = query.with_for_update()
    invite = (await db.execute(query)).scalar_one_or_none()
    if not invite or not _invite_usable(invite):
        raise HTTPException(status_code=404, detail="Приглашение недействительно или истекло")
    return invite


@invites_router.get("/{code}", response_model=InvitePreviewOut)
async def preview_invite(code: str, current_user: CurrentUser, db: Db):
    invite = await _usable_invite(db, code)
    star = (await db.execute(select(Star).where(Star.id == invite.star_id))).scalar_one()
    already = (
        await db.execute(
            select(StarMember).where(StarMember.star_id == star.id, StarMember.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    return InvitePreviewOut(
        code=code,
        star_id=star.id,
        star_name=star.name,
        star_kind=star.kind,
        star_avatar_url=star.avatar_url,
        member_count=await _member_count(db, star.id),
        already_member=already is not None,
    )


@invites_router.post("/{code}/join", response_model=StarDetailOut)
async def join_by_invite(code: str, current_user: CurrentUser, db: Db):
    invite = await _usable_invite(db, code, lock=True)
    star = (
        await db.execute(select(Star).where(Star.id == invite.star_id).with_for_update())
    ).scalar_one()

    existing = (
        await db.execute(
            select(StarMember).where(StarMember.star_id == star.id, StarMember.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if existing:
        await db.commit()
        return await _detail(db, star, existing)

    banned = (
        await db.execute(
            select(StarBan.id).where(StarBan.star_id == star.id, StarBan.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if banned:
        raise _forbid("Вы заблокированы в этой Звезде")
    # В Звёздах владельца ресурса лимита участников нет.
    if not await _is_superuser(db, star.owner_id) and await _member_count(db, star.id) >= rules.MAX_STAR_MEMBERS:
        raise HTTPException(
            status_code=409, detail=f"В Звезде уже {rules.MAX_STAR_MEMBERS} участников — мест нет."
        )

    invite.uses += 1
    me = StarMember(star_id=star.id, user_id=current_user.id, role="member")
    db.add(me)
    await db.commit()
    out = await _member_out(db, me)
    await _broadcast(db, star.id, {"type": "star_member_upsert", "member": out.model_dump(mode="json")})
    await _greet(db, star, current_user)
    return await _detail(db, star, me)


async def _greet(db: AsyncSession, star: Star, user: User) -> None:
    """Приветствие новичка служебным сообщением в выбранном Спутнике."""
    if not star.welcome_channel_id:
        return
    channel = (
        await db.execute(
            select(StarChannel).where(
                StarChannel.id == star.welcome_channel_id,
                StarChannel.star_id == star.id,
                StarChannel.kind == "satellite",
            )
        )
    ).scalar_one_or_none()
    if not channel:
        return
    template = star.welcome_text or "Встречайте {name} — теперь в Звезде!"
    message = StarMessage(
        star_id=star.id,
        channel_id=channel.id,
        sender_id=user.id,
        kind="system",
        text=template.replace("{name}", user.display_name)[: rules.MAX_MESSAGE_LENGTH],
    )
    db.add(message)
    await db.commit()
    out = (await _messages_out(db, [(message, user)]))[0]
    await _broadcast(db, star.id, {"type": "star_message", "message": out.model_dump(mode="json")})


# --- Каналы: Спутники и Планеты ------------------------------------------


async def _channel(db: AsyncSession, star_id: str, channel_id: str) -> StarChannel:
    channel = (
        await db.execute(
            select(StarChannel).where(StarChannel.id == channel_id, StarChannel.star_id == star_id)
        )
    ).scalar_one_or_none()
    if not channel:
        raise HTTPException(status_code=404, detail="Канал не найден")
    return channel


async def _cabinet_owner(
    db: AsyncSession, star: Star, access: str, owner_id: str | None
) -> str | None:
    """Хозяин личного кабинета: только в Звёздах «Работа» и только из участников."""
    if access != "personal":
        return None
    if star.kind != "work":
        raise HTTPException(status_code=400, detail="Личные кабинеты есть только в Звёздах «Работа»")
    if not owner_id:
        raise HTTPException(status_code=400, detail="Укажите, чей это кабинет")
    await _target_member(db, star.id, owner_id)
    return owner_id


def _channel_event(channel: StarChannel) -> dict:
    # Без shared_*: клиент сохраняет их из списка каналов (у хозяина и гостей они разные).
    return {
        "type": "star_channel_upsert",
        "channel": StarChannelOut.model_validate(channel).model_dump(mode="json", exclude={"shared_from", "shared_with"}),
    }


@router.post("/{star_id}/channels", response_model=StarChannelOut, status_code=status.HTTP_201_CREATED)
async def create_channel(star_id: str, body: CreateChannel, current_user: CurrentUser, db: Db):
    star, _ = await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    # Блокируем Звезду: два одновременных запроса не превысят лимит каналов.
    await db.execute(select(Star.id).where(Star.id == star_id).with_for_update())

    existing = (
        await db.execute(
            select(func.count(), func.max(StarChannel.position)).where(
                StarChannel.star_id == star_id,
                StarChannel.kind == body.kind,
                # Зал ожидания — системная комната, в лимит не входит; временные Планеты — тоже.
                or_(StarChannel.room_kind.is_(None), StarChannel.room_kind != "lobby"),
                StarChannel.temporary.is_(False),
            )
        )
    ).one()
    count, max_position = existing
    limit = None if current_user.is_superuser else rules.channel_limit(star.kind, body.kind)
    if limit is not None and count >= limit:
        noun = "Спутников" if body.kind == "satellite" else "Планет"
        raise HTTPException(
            status_code=409, detail=f"В игровой Звезде можно не больше {limit} {noun}."
        )

    channel = StarChannel(
        star_id=star_id,
        kind=body.kind,
        name=body.name,
        position=(max_position + 1) if max_position is not None else 0,
    )
    if body.kind == "satellite":
        channel.announcement = body.announcement
    if body.kind == "planet":
        channel.room_kind = body.room_kind if star.kind == "work" else None
        channel.capacity = body.capacity or rules.default_capacity(channel.room_kind)
        channel.access = body.access
        channel.cabinet_owner_id = await _cabinet_owner(db, star, body.access, body.cabinet_owner_id)
        channel.listen_only = body.listen_only
    db.add(channel)

    floor = None
    if body.kind == "planet" and star.kind == "work":
        floors = await floors_svc.ensure_floors(db, star)
        target = next((f for f in floors if f.id == body.floor_id), floors[0])
        floor = await floors_svc.lock_floor(db, star_id, target.id)
        await floors_svc.place_room(db, channel, floor)

    await db.commit()
    await _broadcast(db, star_id, _channel_event(channel))
    if floor:
        await _broadcast(db, star_id, floors_event(await floors_svc.list_floors(db, star_id)))
    await star_audit.record(db, star_id, current_user.id, "channel_create", channel.id, name=channel.name)
    return channel


@router.patch("/{star_id}/channels/{channel_id}", response_model=StarChannelOut)
async def update_channel(
    star_id: str, channel_id: str, body: UpdateChannel, current_user: CurrentUser, db: Db
):
    star, me = await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channel = await _channel(db, star_id, channel_id)
    if body.name is not None:
        channel.name = body.name
    if channel.kind == "planet":
        if body.capacity is not None:
            channel.capacity = body.capacity
        if body.room_kind is not None and star.kind == "work" and channel.room_kind != "lobby":
            channel.room_kind = body.room_kind
        if (body.access is not None or body.cabinet_owner_id is not None) and channel.room_kind != "lobby":
            access = body.access or channel.access
            owner_id = body.cabinet_owner_id or channel.cabinet_owner_id
            channel.cabinet_owner_id = await _cabinet_owner(db, star, access, owner_id)
            channel.access = access
    listen_only_changed = (
        channel.kind == "planet"
        and body.listen_only is not None
        and body.listen_only != channel.listen_only
    )
    if listen_only_changed:
        channel.listen_only = body.listen_only
    if channel.kind == "satellite" and body.slow_mode_sec is not None:
        channel.slow_mode_sec = body.slow_mode_sec
    if channel.kind == "satellite" and body.announcement is not None:
        channel.announcement = body.announcement

    moved = False
    if (
        channel.kind == "planet"
        and star.kind == "work"
        and body.floor_id is not None
        and body.floor_id != channel.floor_id
    ):
        if not rules.has_perm(me.role, Perm.EDIT_MAP, star.role_permissions):
            raise _forbid("Переносить комнаты между этажами может тот, кто редактирует карту офиса")
        new_floor = await floors_svc.lock_floor(db, star_id, body.floor_id)
        if not new_floor:
            raise HTTPException(status_code=404, detail="Этаж не найден")
        if channel.floor_id:
            old_floor = await floors_svc.lock_floor(db, star_id, channel.floor_id)
            if old_floor:
                old_floor.version += 1
        await floors_svc.place_room(db, channel, new_floor)
        moved = True

    await db.commit()
    await _broadcast(db, star_id, _channel_event(channel))
    if listen_only_changed:
        # Кто уже внутри — сразу забираем (или возвращаем) право на микрофон.
        await voice.set_listen_only(star_id, channel_id, channel.listen_only)
    if moved:
        await _broadcast(db, star_id, floors_event(await floors_svc.list_floors(db, star_id)))
    await star_audit.record(
        db, star_id, current_user.id, "channel_update", channel.id,
        name=channel.name, changes=sorted(body.model_dump(exclude_none=True)),
    )
    return channel


@router.delete("/{star_id}/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channel = await _channel(db, star_id, channel_id)
    is_planet = channel.kind == "planet"
    floor = await floors_svc.lock_floor(db, star_id, channel.floor_id) if channel.floor_id else None
    if floor:
        floor.version += 1  # план этажа изменился
    name = channel.name
    guests = await shares.guest_star_ids(db, channel_id)
    await db.delete(channel)
    await db.commit()
    await _broadcast(db, star_id, {"type": "star_channel_deleted", "channel_id": channel_id})
    # Общий Спутник пропадает и у гостевых Звёзд (подключения ушли каскадом).
    for guest_id in guests:
        await _broadcast(db, guest_id, {"type": "star_channel_deleted", "channel_id": channel_id})
    await star_audit.record(db, star_id, current_user.id, "channel_delete", channel_id, name=name)
    if floor:
        await _broadcast(db, star_id, floors_event(await floors_svc.list_floors(db, star_id)))
    if is_planet:
        await voice.close_planet(star_id, channel_id)


@router.put("/{star_id}/channels/order", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_channels(star_id: str, body: ReorderChannels, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channels = {c.id: c for c in await _channels(db, star_id)}
    # Общие Спутники других Звёзд стоят после своих — их порядок здесь не меняем.
    foreign = set(await shares.shared_channel_ids(db, star_id))
    if not set(body.channel_ids) <= channels.keys() | foreign:
        raise HTTPException(status_code=400, detail="Неизвестный канал")
    own_ids = [i for i in body.channel_ids if i in channels]
    for position, channel_id in enumerate(own_ids):
        channels[channel_id].position = position
    await db.commit()
    await _broadcast(db, star_id, {"type": "star_channels_order", "channel_ids": own_ids})


# --- Сообщения Спутников --------------------------------------------------


async def assert_slow_mode(db: AsyncSession, channel: StarChannel, me: StarMember) -> None:
    """Медленный режим: следующее сообщение — не раньше чем через slow_mode_sec после своего прошлого."""
    if not channel.slow_mode_sec or _staff_here(me, channel):
        return
    last = (
        await db.execute(
            select(func.max(StarMessage.created_at)).where(
                StarMessage.channel_id == channel.id, StarMessage.sender_id == me.user_id
            )
        )
    ).scalar_one_or_none()
    if last:
        wait = channel.slow_mode_sec - (_now() - last).total_seconds()
        if wait > 0:
            raise HTTPException(
                status_code=429, detail=f"Медленный режим: следующее сообщение через {int(wait) + 1} с"
            )


async def _satellite(db: AsyncSession, star_id: str, channel_id: str) -> StarChannel:
    """Спутник этой Звезды или общий Спутник, подключённый к ней. Настройки канала — через _channel."""
    channel = (await db.execute(select(StarChannel).where(StarChannel.id == channel_id))).scalar_one_or_none()
    if not channel or (channel.star_id != star_id and not await shares.is_shared_into(db, channel_id, star_id)):
        raise HTTPException(status_code=404, detail="Канал не найден")
    if channel.kind != "satellite":
        raise HTTPException(status_code=400, detail="Сообщения есть только в Спутниках")
    return channel


async def _messages_out(
    db: AsyncSession, rows: list[tuple[StarMessage, User | None]], viewer_id: str | None = None
) -> list[StarMessageOut]:
    """Сообщения с цитатами ответов и реакциями — двумя запросами на всю страницу."""
    reply_ids = {m.reply_to_id for m, _ in rows if m.reply_to_id}
    replies: dict[str, StarReplyOut] = {}
    if reply_ids:
        reply_rows = await db.execute(
            select(StarMessage, User)
            .outerjoin(User, User.id == StarMessage.sender_id)
            .where(StarMessage.id.in_(reply_ids))
        )
        replies = {
            m.id: StarReplyOut(id=m.id, sender=_user_out(u) if u else None, text=m.text)
            for m, u in reply_rows.all()
        }

    reactions: dict[str, list[StarReactionOut]] = defaultdict(list)
    if rows:
        reaction_rows = await db.execute(
            select(StarMessageReaction)
            .where(StarMessageReaction.message_id.in_([m.id for m, _ in rows]))
            .order_by(StarMessageReaction.created_at)
        )
        for r in reaction_rows.scalars():
            reactions[r.message_id].append(StarReactionOut(user_id=r.user_id, emoji=r.emoji))

    from app.api.star_play import lfgs_out, polls_out

    polls = await polls_out(db, [m.ref_id for m, _ in rows if m.kind == "poll" and m.ref_id], viewer_id)
    lfgs = await lfgs_out(db, [m.ref_id for m, _ in rows if m.kind == "lfg" and m.ref_id])
    threads = await thread_summaries(db, [m.id for m, _ in rows if not m.thread_id])
    file_ids = [m.id for m, _ in rows if m.kind == "file"]
    files: dict[str, StarFileOut] = {}
    if file_ids:
        for f in (await db.execute(select(StarFile).where(StarFile.message_id.in_(file_ids)))).scalars():
            files[f.message_id] = StarFileOut(id=f.id, name=f.name, mime=f.mime, size=f.size)
    ack_ids = [m.id for m, _ in rows if m.ack_required]
    ack_counts: dict[str, int] = {}
    my_acks: set[str] = set()
    if ack_ids:
        ack_counts = dict(
            (
                await db.execute(
                    select(StarMessageAck.message_id, func.count())
                    .where(StarMessageAck.message_id.in_(ack_ids))
                    .group_by(StarMessageAck.message_id)
                )
            ).all()
        )
        if viewer_id:
            my_acks = set(
                (
                    await db.execute(
                        select(StarMessageAck.message_id).where(
                            StarMessageAck.message_id.in_(ack_ids), StarMessageAck.user_id == viewer_id
                        )
                    )
                ).scalars().all()
            )

    return [
        StarMessageOut(
            id=m.id,
            star_id=m.star_id,
            channel_id=m.channel_id,
            sender=_user_out(u) if u else None,
            text=m.text,
            kind=m.kind,
            poll=polls.get(m.ref_id) if m.kind == "poll" else None,
            lfg=lfgs.get(m.ref_id) if m.kind == "lfg" else None,
            file=files.get(m.id),
            mentions=m.mentions or [],
            mention_all=m.mention_all,
            link_preview=m.link_preview,
            bot_name=m.bot_name,
            bot_kind=m.bot_kind,
            thread_id=m.thread_id,
            thread_count=threads.get(m.id, (0, None, []))[0],
            thread_last_at=threads.get(m.id, (0, None, []))[1],
            thread_participants=threads.get(m.id, (0, None, []))[2],
            ack_required=m.ack_required,
            ack_count=ack_counts.get(m.id, 0),
            acked=m.id in my_acks,
            created_at=m.created_at,
            edited_at=m.edited_at,
            reply_to=replies.get(m.reply_to_id) if m.reply_to_id else None,
            reactions=reactions[m.id],
        )
        for m, u in rows
    ]


async def _star_message(db: AsyncSession, star_id: str, channel_id: str, message_id: str) -> StarMessage:
    message = (
        await db.execute(
            select(StarMessage).where(StarMessage.id == message_id, StarMessage.channel_id == channel_id)
        )
    ).scalar_one_or_none()
    if not message or (message.star_id != star_id and not await shares.is_shared_into(db, channel_id, star_id)):
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    return message


@router.get("/{star_id}/channels/{channel_id}/messages", response_model=list[StarMessageOut])
async def list_messages(
    star_id: str,
    channel_id: str,
    current_user: CurrentUser,
    db: Db,
    limit: int = Query(50, ge=1, le=100),
    before_id: str | None = Query(None),
):
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)

    query = (
        select(StarMessage, User)
        .outerjoin(User, User.id == StarMessage.sender_id)
        # Ответы в ветках в ленте не показываются — только сводка под корнем.
        .where(StarMessage.channel_id == channel_id, StarMessage.thread_id.is_(None))
    )
    if before_id:
        cursor = (
            await db.execute(select(StarMessage.created_at).where(StarMessage.id == before_id))
        ).scalar_one_or_none()
        if cursor:
            query = query.where(StarMessage.created_at < cursor)
    rows = (await db.execute(query.order_by(StarMessage.created_at.desc()).limit(limit))).all()
    return _as_star(await _messages_out(db, [(m, u) for m, u in reversed(rows)], current_user.id), star_id)


@router.post(
    "/{star_id}/channels/{channel_id}/messages",
    response_model=StarMessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    star_id: str, channel_id: str, body: SendStarMessage, current_user: CurrentUser, db: Db
):
    star, me, channel, reply_to = await prepare_message(db, star_id, channel_id, body, current_user)
    file = None
    if body.file_id:
        file = (
            await db.execute(
                select(StarFile)
                .where(
                    StarFile.id == body.file_id,
                    StarFile.channel_id == channel_id,
                    StarFile.uploader_id == current_user.id,
                    StarFile.message_id.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if not file:
            raise HTTPException(status_code=422, detail="Файл не найден — загрузите его снова")
    mentions, everyone = await _mentions(db, star_id, me, body.text, channel)
    message = StarMessage(
        # Сообщения общего Спутника хранятся у Звезды-хозяина.
        star_id=channel.star_id,
        channel_id=channel_id,
        sender_id=current_user.id,
        text=body.text,
        kind="file" if file else "text",
        reply_to_id=body.reply_to_id,
        thread_id=body.thread_id,
        ack_required=body.ack_required,
        mentions=mentions,
        mention_all=everyone,
        link_preview=body.link_preview.model_dump() if body.link_preview else None,
    )
    db.add(message)
    await db.flush()
    if file:
        file.message_id = message.id
    await db.commit()
    out = (await _messages_out(db, [(message, current_user)]))[0]
    await _broadcast(db, star_id, {"type": "star_message", "message": out.model_dump(mode="json")})
    if message.thread_id:
        await thread_event(db, star_id, channel_id, message.thread_id)
    await _push_message(db, star, channel, message, current_user, reply_to, file)
    out.star_id = star_id
    return out


async def prepare_message(
    db: AsyncSession,
    star_id: str,
    channel_id: str,
    body: SendStarMessage,
    current_user: User,
    *,
    check_slow_mode: bool = True,
) -> tuple[Star, StarMember, StarChannel, StarMessage | None]:
    """Общие проверки обычной и отложенной отправки; права проверяются и при доставке."""
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _satellite(db, star_id, channel_id)
    assert_can_post(star, me)
    # В общем Спутнике админы гостевой Звезды — обычные участники.
    is_admin = me.role in ("owner", "admin") and me.star_id == channel.star_id
    # В объявлениях пишут владелец и админы; обсуждать в ветках может любой.
    if channel.announcement and not body.thread_id and not is_admin:
        raise _forbid("Здесь пишут только владелец и админы — обсудить можно в ветке")
    if body.ack_required and not (channel.announcement and is_admin and not body.thread_id):
        raise HTTPException(status_code=422, detail="Подтверждение — только для объявлений")
    if body.thread_id:
        root = await _star_message(db, star_id, channel_id, body.thread_id)
        if root.thread_id or root.kind == "system":
            raise HTTPException(status_code=422, detail="Ветку можно начать только от обычного сообщения")
    if check_slow_mode:
        await assert_slow_mode(db, channel, me)
    assert_clean_text(star, me, body.text)
    reply_to = None
    if body.reply_to_id:
        try:
            reply_to = await _star_message(db, star_id, channel_id, body.reply_to_id)
        except HTTPException:
            raise HTTPException(status_code=422, detail="Сообщение для ответа не найдено") from None
    return star, me, channel, reply_to


async def _mentions(
    db: AsyncSession, star_id: str, me: StarMember, text: str, channel: StarChannel | None = None
) -> tuple[list[str], bool]:
    """@имя участников этой Звезды и @группа (все, у кого роль с этим именем упоминания).

    @все и @here — только у модераторов и выше (у остальных это просто текст). @here упоминает
    тех, кто в сети прямо сейчас: их id попадают в mentions, как при упоминании по имени.
    """
    if "@" not in text:
        return [], False
    # В общем Спутнике — участники всех подключённых Звёзд.
    star_ids = await shares.audience_star_ids(db, channel.id, star_id) if channel else [star_id]
    names = dict(
        (
            await db.execute(
                select(func.lower(User.username), User.id)
                .join(StarMember, StarMember.user_id == User.id)
                .where(StarMember.star_id.in_(star_ids))
            )
        ).all()
    )
    groups: dict[str, list[str]] = {}
    for handle, user_id in (
        await db.execute(
            select(func.lower(StarTag.handle), StarMemberTag.user_id)
            .join(StarMemberTag, StarMemberTag.tag_id == StarTag.id)
            .where(StarTag.star_id == star_id, StarTag.handle.is_not(None))
        )
    ).all():
        groups.setdefault(handle, []).append(user_id)
    found = notify.find_mentions(text, names, groups)
    staff = _staff_here(me, channel) if channel else rules.is_staff(me.role)
    if found.here and staff:
        found.ids.update(uid for uid in names.values() if presence.status_of(uid) == presence.ONLINE)
    found.ids.discard(me.user_id)
    return sorted(found.ids), found.everyone and staff


async def _push_message(
    db: AsyncSession,
    star: Star,
    channel: StarChannel,
    message: StarMessage,
    sender: User,
    reply_to: StarMessage | None,
    file: StarFile | None,
) -> None:
    """Push тем, кто не в приложении: по их уровню уведомлений. Ответ мне и ответ в моей ветке — как упоминание."""
    also = {reply_to.sender_id} if reply_to and reply_to.sender_id else set()
    if message.thread_id:
        root_author = (
            await db.execute(select(StarMessage.sender_id).where(StarMessage.id == message.thread_id))
        ).scalar_one_or_none()
        if root_author:
            also.add(root_author)
    also.discard(sender.id)
    targets = await notify.star_push_targets(db, star, channel, message, also)
    body = markup.plain_text(message.text or "") or (f"📎 {file.name}" if file else "")
    notify.push_later(
        targets,
        {
            "type": "star_message",
            "title": f"{sender.display_name} · #{channel.name} · {star.name}",
            "body": body[:200],
            "star_id": star.id,
            "channel_id": channel.id,
            "message_id": message.id,
            "tag": f"quazar-star-{channel.id}",
        },
    )


async def thread_summaries(db: AsyncSession, root_ids: list[str]) -> dict[str, tuple[int, datetime | None, list[str]]]:
    """root_id → (сколько ответов, когда последний, до трёх последних участников)."""
    if not root_ids:
        return {}
    rows = (
        await db.execute(
            select(StarMessage.thread_id, StarMessage.sender_id, StarMessage.created_at)
            .where(StarMessage.thread_id.in_(root_ids))
            .order_by(StarMessage.created_at.desc())
        )
    ).all()
    out: dict[str, tuple[int, datetime | None, list[str]]] = {}
    for root_id, sender_id, at in rows:
        count, last, people = out.get(root_id, (0, None, []))
        if sender_id and sender_id not in people and len(people) < 3:
            people = [*people, sender_id]
        out[root_id] = (count + 1, last or at, people)
    return out


async def thread_event(db: AsyncSession, star_id: str, channel_id: str, root_id: str) -> None:
    count, last, people = (await thread_summaries(db, [root_id])).get(root_id, (0, None, []))
    await _broadcast(
        db,
        star_id,
        {
            "type": "star_thread",
            "channel_id": channel_id,
            "root_id": root_id,
            "count": count,
            "last_at": last.isoformat() if last else None,
            "participants": people,
        },
    )


@router.patch("/{star_id}/channels/{channel_id}/messages/{message_id}", response_model=StarMessageOut)
async def edit_message(
    star_id: str,
    channel_id: str,
    message_id: str,
    body: EditStarMessage,
    current_user: CurrentUser,
    db: Db,
):
    """Исправить можно только своё сообщение — модераторам доступно лишь удаление."""
    star, me = await _load_membership(db, star_id, current_user.id)
    message = await _star_message(db, star_id, channel_id, message_id)
    if message.sender_id != current_user.id or message.kind != "text":
        raise _forbid("Исправить можно только своё сообщение")
    assert_can_post(star, me)
    assert_clean_text(star, me, body.text)
    if body.text != message.text:
        await revisions.remember(
            db, StarMessageRevision, message.id, message.edited_at or message.created_at, text=message.text
        )
    message.text = body.text
    # Ссылки в новом тексте другие — старое превью убираем.
    message.link_preview = None
    # Упоминания пересчитываем для подсветки; push о правке не шлём.
    channel = await _satellite(db, star_id, channel_id)
    message.mentions, message.mention_all = await _mentions(db, star_id, me, body.text, channel)
    message.edited_at = _now()
    await db.commit()
    await _broadcast(
        db,
        star_id,
        {
            "type": "star_message_edited",
            "channel_id": channel_id,
            "message_id": message_id,
            "text": message.text,
            "edited_at": message.edited_at.isoformat(),
            "mentions": message.mentions or [],
            "mention_all": message.mention_all,
        },
    )
    return _as_star(await _messages_out(db, [(message, current_user)]), star_id)[0]


class StarRevisionOut(BaseModel):
    text: str
    written_at: datetime


@router.get(
    "/{star_id}/channels/{channel_id}/messages/{message_id}/revisions", response_model=list[StarRevisionOut]
)
async def list_revisions(star_id: str, channel_id: str, message_id: str, current_user: CurrentUser, db: Db):
    """Прежние версии исправленного сообщения, старые первыми. Текущая — в самом сообщении."""
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    await _star_message(db, star_id, channel_id, message_id)
    rows = await db.execute(
        select(StarMessageRevision)
        .where(StarMessageRevision.message_id == message_id)
        .order_by(StarMessageRevision.written_at)
    )
    return [StarRevisionOut(text=r.text, written_at=r.written_at) for r in rows.scalars()]


@router.put(
    "/{star_id}/channels/{channel_id}/messages/{message_id}/reaction",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def set_reaction(
    star_id: str,
    channel_id: str,
    message_id: str,
    body: SetStarReaction,
    current_user: CurrentUser,
    db: Db,
):
    """Поставить или сменить свою реакцию (одна на человека)."""
    star, me = await _load_membership(db, star_id, current_user.id)
    await _star_message(db, star_id, channel_id, message_id)
    assert_can_post(star, me)
    now = _now()
    await db.execute(
        insert(StarMessageReaction)
        .values(message_id=message_id, user_id=current_user.id, emoji=body.emoji, created_at=now)
        .on_conflict_do_update(
            index_elements=[StarMessageReaction.message_id, StarMessageReaction.user_id],
            set_={"emoji": body.emoji, "created_at": now},
        )
    )
    await db.commit()
    await _broadcast_reaction(db, star_id, channel_id, message_id, current_user.id, body.emoji)


@router.delete(
    "/{star_id}/channels/{channel_id}/messages/{message_id}/reaction",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_reaction(
    star_id: str, channel_id: str, message_id: str, current_user: CurrentUser, db: Db
):
    await _load_membership(db, star_id, current_user.id)
    await _star_message(db, star_id, channel_id, message_id)
    await db.execute(
        delete(StarMessageReaction).where(
            StarMessageReaction.message_id == message_id,
            StarMessageReaction.user_id == current_user.id,
        )
    )
    await db.commit()
    await _broadcast_reaction(db, star_id, channel_id, message_id, current_user.id, None)


async def _broadcast_reaction(
    db: AsyncSession, star_id: str, channel_id: str, message_id: str, user_id: str, emoji: str | None
) -> None:
    await _broadcast(
        db,
        star_id,
        {
            "type": "star_message_reaction",
            "channel_id": channel_id,
            "message_id": message_id,
            "user_id": user_id,
            "emoji": emoji,
        },
    )


@router.delete(
    "/{star_id}/channels/{channel_id}/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_message(
    star_id: str, channel_id: str, message_id: str, current_user: CurrentUser, db: Db
):
    star, me = await _load_membership(db, star_id, current_user.id)
    message = await _star_message(db, star_id, channel_id, message_id)
    # Чужие сообщения общего Спутника удаляют модераторы Звезды-хозяина, гости — только свои.
    home = message.star_id == me.star_id
    sender_role = None
    if message.sender_id:
        sender = (
            await db.execute(
                select(StarMember.role).where(
                    StarMember.star_id == message.star_id, StarMember.user_id == message.sender_id
                )
            )
        ).scalar_one_or_none()
        sender_role = sender
    if not rules.can_delete_message(
        current_user.id, me.role if home else "member", message.sender_id, sender_role, star.role_permissions
    ):
        raise _forbid()
    if message.sender_id != current_user.id:
        await star_audit.record(
            db, star_id, current_user.id, "message_delete", message.sender_id, text=message.text[:200]
        )

    root_id = message.thread_id
    # Файлы сообщения и его ветки: строки уйдут каскадом, с диска убираем сразу.
    file_ids = (
        await db.execute(
            select(StarFile.id)
            .join(StarMessage, StarMessage.id == StarFile.message_id)
            .where(or_(StarMessage.id == message.id, StarMessage.thread_id == message.id))
        )
    ).scalars().all()
    await db.delete(message)
    await db.commit()
    for file_id in file_ids:
        star_files.delete_file(file_id)
    await _broadcast(
        db,
        star_id,
        {"type": "star_message_deleted", "channel_id": channel_id, "message_id": message_id},
    )
    if root_id:
        await thread_event(db, star_id, channel_id, root_id)

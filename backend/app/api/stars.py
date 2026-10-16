"""Созвездие: Звёзды, участники и роли, приглашения, Спутники и Планеты, сообщения Спутников.

Все лимиты и права проверяются здесь, на сервере; правила — в app.core.stars.
"""

import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import Star, StarBan, StarChannel, StarInvite, StarMember, StarMessage
from app.models.user import User
from app.schemas.star import (
    CreateChannel,
    CreateInvite,
    CreateStar,
    InvitePreviewOut,
    ReorderChannels,
    SendStarMessage,
    StarBanOut,
    StarChannelOut,
    StarDetailOut,
    StarInviteOut,
    StarLimitsOut,
    StarMemberOut,
    StarMessageOut,
    StarSummaryOut,
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
    return StarUserOut(id=user.id, username=user.username, avatar_url=user.avatar_url)


async def _load_membership(db: AsyncSession, star_id: str, user_id: str) -> tuple[Star, StarMember]:
    """Звезда и участие текущего пользователя. Чужим Звёздам — 404, чтобы не раскрывать их."""
    row = (
        await db.execute(
            select(Star, StarMember)
            .join(StarMember, StarMember.star_id == Star.id)
            .where(Star.id == star_id, StarMember.user_id == user_id)
        )
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Звезда не найдена")
    return row[0], row[1]


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


async def _broadcast(db: AsyncSession, star_id: str, event: dict, *, also: tuple[str, ...] = ()) -> None:
    user_ids = set(await _member_ids(db, star_id)) | set(also)
    await manager.broadcast_to_users(list(user_ids), {"star_id": star_id, **event})


async def _members_out(db: AsyncSession, star_id: str) -> list[StarMemberOut]:
    rows = (
        await db.execute(
            select(StarMember, User)
            .join(User, User.id == StarMember.user_id)
            .where(StarMember.star_id == star_id)
        )
    ).all()
    members = [
        StarMemberOut(user=_user_out(user), role=m.role, joined_at=m.joined_at) for m, user in rows
    ]
    members.sort(key=lambda m: (-rules.rank(m.role), m.joined_at))
    return members


async def _member_out(db: AsyncSession, member: StarMember) -> StarMemberOut:
    user = (await db.execute(select(User).where(User.id == member.user_id))).scalar_one()
    return StarMemberOut(user=_user_out(user), role=member.role, joined_at=member.joined_at)


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
        created_at=star.created_at,
        member_count=member_count,
        my_role=my_role,
    )


async def _detail(db: AsyncSession, star: Star, me: StarMember) -> StarDetailOut:
    members = await _members_out(db, star.id)
    channels = await _channels(db, star.id)
    return StarDetailOut(
        **_summary(star, me.role, len(members)).model_dump(),
        my_permissions=rules.effective_permissions(me.role, star.role_permissions),
        role_permissions=rules.normalize_role_permissions(star.role_permissions),
        channels=[StarChannelOut.model_validate(c) for c in channels],
        members=members,
    )


async def _remove_member(db: AsyncSession, star_id: str, user_id: str, reason: str) -> None:
    """Удаляет участника и сообщает: ему — что он больше не в Звезде, остальным — что ушёл."""
    await db.execute(
        delete(StarMember).where(StarMember.star_id == star_id, StarMember.user_id == user_id)
    )
    await db.commit()
    await _broadcast(db, star_id, {"type": "star_member_removed", "user_id": user_id, "reason": reason})
    await manager.send_to_user(user_id, {"type": "star_removed", "star_id": star_id, "reason": reason})


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
    if await _owned_count(db, current_user.id) >= rules.MAX_OWNED_STARS:
        raise HTTPException(
            status_code=409,
            detail=f"Можно создать не больше {rules.MAX_OWNED_STARS} Звёзд. "
            "Удалите или передайте одну из своих.",
        )

    star = Star(
        name=body.name,
        kind=body.kind,
        owner_id=current_user.id,
        role_permissions=rules.normalize_role_permissions(None),
    )
    db.add(star)
    await db.flush()
    me = StarMember(star_id=star.id, user_id=current_user.id, role="owner")
    db.add(me)
    db.add_all(_default_channels(star))
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
    await _broadcast(db, star_id, {"type": "star_updated", "name": star.name, "owner_id": star.owner_id})
    return await _detail(db, star, me)


@router.delete("/{star_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_star(star_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role != "owner":
        raise _forbid("Удалить Звезду может только владелец")
    member_ids = await _member_ids(db, star_id)
    await db.execute(delete(Star).where(Star.id == star_id))
    await db.commit()
    await manager.broadcast_to_users(
        member_ids, {"type": "star_removed", "star_id": star_id, "reason": "deleted"}
    )


@router.post("/{star_id}/transfer", response_model=StarDetailOut)
async def transfer_star(star_id: str, body: TransferStar, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role != "owner":
        raise _forbid("Передать Звезду может только владелец")
    if body.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Звезда уже ваша")
    target = await _target_member(db, star_id, body.user_id)

    await _lock_user(db, body.user_id)
    if await _owned_count(db, body.user_id) >= rules.MAX_OWNED_STARS:
        raise HTTPException(
            status_code=409,
            detail=f"У этого участника уже {rules.MAX_OWNED_STARS} своих Звезды — передать нельзя.",
        )

    star.owner_id = body.user_id
    target.role = "owner"
    me.role = "admin"
    await db.commit()

    for member in (target, me):
        await _broadcast(
            db, star_id, {"type": "star_member_upsert", "member": (await _member_out(db, member)).model_dump(mode="json")}
        )
    await _broadcast(db, star_id, {"type": "star_updated", "name": star.name, "owner_id": star.owner_id})
    return await _detail(db, star, me)


@router.post("/{star_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_star(star_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    if me.role == "owner":
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
    target.role = body.role
    await db.commit()
    out = await _member_out(db, target)
    await _broadcast(db, star_id, {"type": "star_member_upsert", "member": out.model_dump(mode="json")})
    return out


@router.post("/{star_id}/members/{user_id}/kick", status_code=status.HTTP_204_NO_CONTENT)
async def kick_member(star_id: str, user_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    target = await _target_member(db, star_id, user_id)
    if not rules.can_kick(me.role, target.role, star.role_permissions):
        raise _forbid()
    await _remove_member(db, star_id, user_id, "kick")


@router.post("/{star_id}/members/{user_id}/ban", status_code=status.HTTP_204_NO_CONTENT)
async def ban_member(star_id: str, user_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    target = await _target_member(db, star_id, user_id)
    if not rules.can_ban(me.role, target.role):
        raise _forbid("Блокировать могут только владелец и админы")
    db.add(StarBan(star_id=star_id, user_id=user_id, banned_by=current_user.id))
    await _remove_member(db, star_id, user_id, "ban")


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


@router.put("/{star_id}/permissions", response_model=dict[str, list[str]])
async def update_permissions(
    star_id: str, body: UpdateRolePermissions, current_user: CurrentUser, db: Db
):
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role != "owner":
        raise _forbid("Права настраивает владелец")
    star.role_permissions = rules.normalize_role_permissions(body.model_dump())
    await db.commit()
    await _broadcast(db, star_id, {"type": "star_permissions", "role_permissions": star.role_permissions})
    return star.role_permissions


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
    if await _member_count(db, star.id) >= rules.MAX_STAR_MEMBERS:
        raise HTTPException(
            status_code=409, detail=f"В Звезде уже {rules.MAX_STAR_MEMBERS} участников — мест нет."
        )

    invite.uses += 1
    me = StarMember(star_id=star.id, user_id=current_user.id, role="member")
    db.add(me)
    await db.commit()
    out = await _member_out(db, me)
    await _broadcast(db, star.id, {"type": "star_member_upsert", "member": out.model_dump(mode="json")})
    return await _detail(db, star, me)


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


def _channel_event(channel: StarChannel) -> dict:
    return {
        "type": "star_channel_upsert",
        "channel": StarChannelOut.model_validate(channel).model_dump(mode="json"),
    }


@router.post("/{star_id}/channels", response_model=StarChannelOut, status_code=status.HTTP_201_CREATED)
async def create_channel(star_id: str, body: CreateChannel, current_user: CurrentUser, db: Db):
    star, _ = await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    # Блокируем Звезду: два одновременных запроса не превысят лимит каналов.
    await db.execute(select(Star.id).where(Star.id == star_id).with_for_update())

    existing = (
        await db.execute(
            select(func.count(), func.max(StarChannel.position)).where(
                StarChannel.star_id == star_id, StarChannel.kind == body.kind
            )
        )
    ).one()
    count, max_position = existing
    limit = rules.channel_limit(star.kind, body.kind)
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
    if body.kind == "planet":
        channel.room_kind = body.room_kind if star.kind == "work" else None
        channel.capacity = body.capacity or rules.default_capacity(channel.room_kind)
    db.add(channel)
    await db.commit()
    await _broadcast(db, star_id, _channel_event(channel))
    return channel


@router.patch("/{star_id}/channels/{channel_id}", response_model=StarChannelOut)
async def update_channel(
    star_id: str, channel_id: str, body: UpdateChannel, current_user: CurrentUser, db: Db
):
    star, _ = await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channel = await _channel(db, star_id, channel_id)
    if body.name is not None:
        channel.name = body.name
    if channel.kind == "planet":
        if body.capacity is not None:
            channel.capacity = body.capacity
        if body.room_kind is not None and star.kind == "work":
            channel.room_kind = body.room_kind
    await db.commit()
    await _broadcast(db, star_id, _channel_event(channel))
    return channel


@router.delete("/{star_id}/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channel = await _channel(db, star_id, channel_id)
    await db.delete(channel)
    await db.commit()
    await _broadcast(db, star_id, {"type": "star_channel_deleted", "channel_id": channel_id})


@router.put("/{star_id}/channels/order", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_channels(star_id: str, body: ReorderChannels, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channels = {c.id: c for c in await _channels(db, star_id)}
    if not set(body.channel_ids) <= channels.keys():
        raise HTTPException(status_code=400, detail="Неизвестный канал")
    for position, channel_id in enumerate(body.channel_ids):
        channels[channel_id].position = position
    await db.commit()
    await _broadcast(db, star_id, {"type": "star_channels_order", "channel_ids": body.channel_ids})


# --- Сообщения Спутников --------------------------------------------------


async def _satellite(db: AsyncSession, star_id: str, channel_id: str) -> StarChannel:
    channel = await _channel(db, star_id, channel_id)
    if channel.kind != "satellite":
        raise HTTPException(status_code=400, detail="Сообщения есть только в Спутниках")
    return channel


def _message_out(message: StarMessage, sender: User | None) -> StarMessageOut:
    return StarMessageOut(
        id=message.id,
        star_id=message.star_id,
        channel_id=message.channel_id,
        sender=_user_out(sender) if sender else None,
        text=message.text,
        created_at=message.created_at,
    )


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
        .where(StarMessage.channel_id == channel_id)
    )
    if before_id:
        cursor = (
            await db.execute(select(StarMessage.created_at).where(StarMessage.id == before_id))
        ).scalar_one_or_none()
        if cursor:
            query = query.where(StarMessage.created_at < cursor)
    rows = (await db.execute(query.order_by(StarMessage.created_at.desc()).limit(limit))).all()
    return [_message_out(m, u) for m, u in reversed(rows)]


@router.post(
    "/{star_id}/channels/{channel_id}/messages",
    response_model=StarMessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    star_id: str, channel_id: str, body: SendStarMessage, current_user: CurrentUser, db: Db
):
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    message = StarMessage(
        star_id=star_id, channel_id=channel_id, sender_id=current_user.id, text=body.text
    )
    db.add(message)
    await db.commit()
    out = _message_out(message, current_user)
    await _broadcast(db, star_id, {"type": "star_message", "message": out.model_dump(mode="json")})
    return out


@router.delete(
    "/{star_id}/channels/{channel_id}/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_message(
    star_id: str, channel_id: str, message_id: str, current_user: CurrentUser, db: Db
):
    star, me = await _load_membership(db, star_id, current_user.id)
    message = (
        await db.execute(
            select(StarMessage).where(StarMessage.id == message_id, StarMessage.channel_id == channel_id)
        )
    ).scalar_one_or_none()
    if not message or message.star_id != star_id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")

    sender_role = None
    if message.sender_id:
        sender = (
            await db.execute(
                select(StarMember.role).where(
                    StarMember.star_id == star_id, StarMember.user_id == message.sender_id
                )
            )
        ).scalar_one_or_none()
        sender_role = sender
    if not rules.can_delete_message(
        current_user.id, me.role, message.sender_id, sender_role, star.role_permissions
    ):
        raise _forbid()

    await db.delete(message)
    await db.commit()
    await _broadcast(
        db,
        star_id,
        {"type": "star_message_deleted", "channel_id": channel_id, "message_id": message_id},
    )

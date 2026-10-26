"""Гостевые ссылки: человек без аккаунта заходит по ссылке в одну комнату рабочей Звезды.

Гость видит только эту комнату — ни Спутников, ни участников Звезды, ни других комнат. Говорит
(если комната не «только слушать»), главным в комнате не становится. Ссылка живёт до срока
или пока её не отзовут; отзыв выводит из комнаты и тех гостей, что уже внутри.
"""

import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.doors import INVITE, PERSONAL, can_admit, door
from app.api.stars import _channel, _load_membership
from app.core import livekit, voice
from app.core import stars as rules
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import Star, StarChannel, StarGuestLink, StarMember
from app.models.user import User

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
    в «по приглашениям» — главный и те, кто впускает, в кабинет — хозяин, админы, владелец."""
    kind = door(channel)
    if kind == PERSONAL:
        return member.user_id == channel.cabinet_owner_id or member.role in ("owner", "admin")
    if kind == INVITE:
        return voice.host(channel.id) == member.user_id or can_admit(star, member)
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
    if not can_invite_guests(star, me, channel):
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

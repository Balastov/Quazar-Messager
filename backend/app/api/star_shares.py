"""Общие Спутники между Звёздами (как Slack Connect).

Хозяин (право «Каналы» в своей Звезде) выпускает одноразовый код на 7 дней. Админ другой
Звезды (право «Каналы» в ней) вводит код — Спутник появляется в её списке. Отключить может
хозяин (у любой гостевой Звезды) или сама гостевая Звезда (у себя). Доступ к сообщениям,
файлам, закладкам и заметкам — app/core/shares.py и проверки в app/api/stars.py.
"""

import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import (
    _channel,
    _member_ids,
    _require_perm,
    _shared_star,
    channels_out,
)
from app.core import shares, star_audit
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import Star, StarChannel, StarChannelShare, StarShareInvite
from app.models.user import User
from app.schemas.star import SharedStarOut
from app.ws.hub import manager

router = APIRouter(prefix="/stars", tags=["stars"])
invites_router = APIRouter(prefix="/star-share-invites", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

INVITE_TTL = timedelta(days=7)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ShareInviteOut(BaseModel):
    code: str
    expires_at: datetime


class ShareOut(BaseModel):
    star: SharedStarOut
    created_at: datetime


class InvitePreview(BaseModel):
    channel_name: str
    star: SharedStarOut
    expires_at: datetime


class AcceptBody(BaseModel):
    # В какую свою Звезду подключить.
    star_id: str


async def _shared_with(db: AsyncSession, channel_id: str) -> list[SharedStarOut]:
    rows = await db.execute(
        select(Star)
        .join(StarChannelShare, StarChannelShare.star_id == Star.id)
        .where(StarChannelShare.channel_id == channel_id)
        .order_by(StarChannelShare.created_at)
    )
    return [_shared_star(s) for s in rows.scalars()]


async def _send(db: AsyncSession, star_id: str, event: dict) -> None:
    await manager.broadcast_to_users(await _member_ids(db, star_id), {"star_id": star_id, **event})


async def _home_changed(db: AsyncSession, channel: StarChannel) -> None:
    """Хозяину — новый список Звёзд, с которыми Спутник общий (подпись в шапке и списке)."""
    await _send(
        db,
        channel.star_id,
        {
            "type": "star_channel_shared",
            "channel_id": channel.id,
            "shared_with": [s.model_dump() for s in await _shared_with(db, channel.id)],
        },
    )


async def _home_satellite(db: AsyncSession, star_id: str, channel_id: str) -> StarChannel:
    channel = await _channel(db, star_id, channel_id)
    if channel.kind != "satellite":
        raise HTTPException(status_code=400, detail="Общими бывают только Спутники")
    return channel


@router.post(
    "/{star_id}/channels/{channel_id}/share-invites",
    response_model=ShareInviteOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_share_invite(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channel = await _home_satellite(db, star_id, channel_id)
    if len(await shares.guest_star_ids(db, channel_id)) >= shares.MAX_SHARES:
        raise HTTPException(status_code=409, detail=f"Спутник уже общий с {shares.MAX_SHARES} Звёздами — это предел")
    # Просроченные коды этого Спутника больше не нужны.
    await db.execute(
        delete(StarShareInvite).where(StarShareInvite.channel_id == channel_id, StarShareInvite.expires_at <= _now())
    )
    invite = StarShareInvite(
        code=secrets.token_urlsafe(12), channel_id=channel.id, created_by=current_user.id, expires_at=_now() + INVITE_TTL
    )
    db.add(invite)
    await db.commit()
    return ShareInviteOut(code=invite.code, expires_at=invite.expires_at)


@router.get("/{star_id}/channels/{channel_id}/shares", response_model=list[ShareOut])
async def list_shares(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    await _home_satellite(db, star_id, channel_id)
    rows = await db.execute(
        select(StarChannelShare, Star)
        .join(Star, Star.id == StarChannelShare.star_id)
        .where(StarChannelShare.channel_id == channel_id)
        .order_by(StarChannelShare.created_at)
    )
    return [ShareOut(star=_shared_star(s), created_at=link.created_at) for link, s in rows.all()]


@router.delete("/{star_id}/channels/{channel_id}/shares/{guest_star_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_share(star_id: str, channel_id: str, guest_star_id: str, current_user: CurrentUser, db: Db):
    """Хозяин отключает гостевую Звезду — или гостевая Звезда отключается сама (star_id == guest_star_id)."""
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    channel = (await db.execute(select(StarChannel).where(StarChannel.id == channel_id))).scalar_one_or_none()
    link = (
        await db.execute(
            select(StarChannelShare).where(
                StarChannelShare.channel_id == channel_id, StarChannelShare.star_id == guest_star_id
            )
        )
    ).scalar_one_or_none()
    if not channel or not link or star_id not in (channel.star_id, guest_star_id):
        raise HTTPException(status_code=404, detail="Общий Спутник не найден")
    guest = await db.get(Star, guest_star_id)
    await db.delete(link)
    await db.commit()
    await _send(db, guest_star_id, {"type": "star_channel_deleted", "channel_id": channel_id})
    await _home_changed(db, channel)
    await star_audit.record(
        db, channel.star_id, current_user.id, "channel_share", channel_id,
        op="remove", channel=channel.name, star=guest.name if guest else None,
    )


@invites_router.get("/{code}", response_model=InvitePreview)
async def preview_invite(code: str, current_user: CurrentUser, db: Db):
    invite, channel, home = await _valid_invite(db, code)
    return InvitePreview(channel_name=channel.name, star=_shared_star(home), expires_at=invite.expires_at)


async def _valid_invite(db: AsyncSession, code: str) -> tuple[StarShareInvite, StarChannel, Star]:
    invite = await db.get(StarShareInvite, code.strip())
    if not invite or invite.expires_at <= _now():
        raise HTTPException(status_code=404, detail="Код не найден или истёк — попросите новый")
    channel = await db.get(StarChannel, invite.channel_id)
    home = await db.get(Star, channel.star_id) if channel else None
    if not channel or not home:
        raise HTTPException(status_code=404, detail="Спутник уже удалён")
    return invite, channel, home


@invites_router.post("/{code}/accept", response_model=SharedStarOut)
async def accept_invite(code: str, body: AcceptBody, current_user: CurrentUser, db: Db):
    """Подключить общий Спутник к своей Звезде. Код одноразовый."""
    await _require_perm(db, body.star_id, current_user, Perm.MANAGE_CHANNELS)
    invite, channel, home = await _valid_invite(db, code)
    if channel.star_id == body.star_id:
        raise HTTPException(status_code=409, detail="Это Спутник вашей же Звезды")
    if await shares.is_shared_into(db, channel.id, body.star_id):
        raise HTTPException(status_code=409, detail="Этот Спутник уже подключён")
    count = (
        await db.execute(select(func.count()).select_from(StarChannelShare).where(StarChannelShare.channel_id == channel.id))
    ).scalar_one()
    if count >= shares.MAX_SHARES:
        raise HTTPException(status_code=409, detail=f"Спутник уже общий с {shares.MAX_SHARES} Звёздами — это предел")
    db.add(StarChannelShare(channel_id=channel.id, star_id=body.star_id, created_by=current_user.id))
    await db.delete(invite)
    await db.commit()
    guest = await db.get(Star, body.star_id)
    # Гостевой Звезде — новый канал в списке (с подписью «Из …»), хозяину — новая подпись «Общий с …».
    item = next(c for c in await channels_out(db, body.star_id) if c.id == channel.id)
    await _send(db, body.star_id, {"type": "star_channel_upsert", "channel": item.model_dump(mode="json")})
    await _home_changed(db, channel)
    await star_audit.record(
        db, channel.star_id, current_user.id, "channel_share", channel.id,
        op="add", channel=channel.name, star=guest.name if guest else None,
    )
    return _shared_star(home)

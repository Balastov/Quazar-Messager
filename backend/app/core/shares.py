"""Общие Спутники: кто ещё видит канал, кроме своей Звезды.

Канал живёт в Звезде-хозяине (StarChannel.star_id), сообщения и файлы хранятся с её star_id.
Гостевая Звезда работает с ним по своим адресам (/stars/<гость>/channels/<канал>/…): сервер
пускает, если канал к ней подключён. События рассылаются участникам всех этих Звёзд — каждому
с star_id его Звезды, чтобы клиент положил их куда надо.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.star import StarChannel, StarChannelShare

# К скольким Звёздам можно подключить один Спутник.
MAX_SHARES = 5


async def guest_star_ids(db: AsyncSession, channel_id: str) -> list[str]:
    rows = await db.execute(
        select(StarChannelShare.star_id)
        .where(StarChannelShare.channel_id == channel_id)
        .order_by(StarChannelShare.created_at)
    )
    return list(rows.scalars())


async def is_shared_into(db: AsyncSession, channel_id: str, star_id: str) -> bool:
    row = await db.execute(
        select(StarChannelShare.channel_id).where(
            StarChannelShare.channel_id == channel_id, StarChannelShare.star_id == star_id
        )
    )
    return row.first() is not None


async def audience_star_ids(db: AsyncSession, channel_id: str, fallback: str) -> list[str]:
    """Звезды, чьим участникам видно событие канала: хозяин первым, затем гости.

    Канала нет (удалили) или не Спутник без гостей — только fallback."""
    guests = await guest_star_ids(db, channel_id)
    if not guests:
        return [fallback]
    home = (await db.execute(select(StarChannel.star_id).where(StarChannel.id == channel_id))).scalar_one_or_none()
    stars = [home or fallback, *guests]
    if fallback not in stars:
        stars.append(fallback)
    return stars


async def shared_into(db: AsyncSession, star_id: str) -> list[StarChannel]:
    """Чужие Спутники, подключённые к этой Звезде."""
    rows = await db.execute(
        select(StarChannel)
        .join(StarChannelShare, StarChannelShare.channel_id == StarChannel.id)
        .where(StarChannelShare.star_id == star_id)
        .order_by(StarChannelShare.created_at)
    )
    return list(rows.scalars())


async def shared_channel_ids(db: AsyncSession, star_id: str) -> list[str]:
    return [c.id for c in await shared_into(db, star_id)]


def for_star(event: object, home_ids: set[str], star_id: str) -> object:
    """Копия события, где star_id Звезды-хозяина заменён на star_id получателя."""
    if isinstance(event, dict):
        return {
            k: (star_id if k == "star_id" and v in home_ids else for_star(v, home_ids, star_id))
            for k, v in event.items()
        }
    if isinstance(event, list):
        return [for_star(v, home_ids, star_id) for v in event]
    return event

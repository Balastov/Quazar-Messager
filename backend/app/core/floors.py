"""Этажи карты офиса и расстановка комнат (работа с БД)."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import office
from app.models.star import Star, StarChannel, StarFloor


def rect_of(channel: StarChannel) -> office.Rect | None:
    if None in (channel.map_x, channel.map_y, channel.map_w, channel.map_h):
        return None
    return office.Rect(channel.map_x, channel.map_y, channel.map_w, channel.map_h)


async def list_floors(db: AsyncSession, star_id: str) -> list[StarFloor]:
    result = await db.execute(
        select(StarFloor)
        .where(StarFloor.star_id == star_id)
        .order_by(StarFloor.position, StarFloor.created_at)
    )
    return list(result.scalars().all())


async def floor_rooms(db: AsyncSession, floor_id: str) -> list[StarChannel]:
    result = await db.execute(
        select(StarChannel).where(StarChannel.floor_id == floor_id, StarChannel.kind == "planet")
    )
    return list(result.scalars().all())


async def lock_floor(db: AsyncSession, star_id: str, floor_id: str) -> StarFloor | None:
    return (
        await db.execute(
            select(StarFloor)
            .where(StarFloor.id == floor_id, StarFloor.star_id == star_id)
            .with_for_update()
        )
    ).scalar_one_or_none()


async def place_room(db: AsyncSession, channel: StarChannel, floor: StarFloor) -> bool:
    """Ставит комнату на свободное место этажа. False — места нет (комната остаётся вне карты)."""
    occupied = [
        r
        for other in await floor_rooms(db, floor.id)
        if other.id != channel.id and (r := rect_of(other)) is not None
    ]
    spot = office.place(occupied, channel.room_kind)
    channel.floor_id = floor.id
    if spot:
        channel.map_x, channel.map_y, channel.map_w, channel.map_h = spot
    else:
        channel.map_x = channel.map_y = channel.map_w = channel.map_h = None
    floor.version += 1
    return spot is not None


async def create_floor(db: AsyncSession, star_id: str, name: str) -> StarFloor:
    max_position = (
        await db.execute(select(func.max(StarFloor.position)).where(StarFloor.star_id == star_id))
    ).scalar_one()
    floor = StarFloor(
        star_id=star_id, name=name, position=0 if max_position is None else max_position + 1, version=0
    )
    db.add(floor)
    await db.flush()
    return floor


async def ensure_floors(db: AsyncSession, star: Star) -> list[StarFloor]:
    """У рабочей Звезды всегда есть этаж, а у каждой комнаты — место на нём.

    Нужна и для Звёзд, созданных до появления карты: при первом открытии получат «1 этаж».
    Возвращает этажи; коммитит, только если что-то поменялось.
    """
    if star.kind != "work":
        return []
    floors = await list_floors(db, star.id)
    unplaced = list(
        (
            await db.execute(
                select(StarChannel).where(
                    StarChannel.star_id == star.id,
                    StarChannel.kind == "planet",
                    StarChannel.floor_id.is_(None),
                )
            )
        ).scalars()
    )
    if floors and not unplaced:
        return floors

    # Блокируем Звезду: два одновременных открытия не создадут два «1 этажа».
    await db.execute(select(Star.id).where(Star.id == star.id).with_for_update())
    floors = await list_floors(db, star.id)
    if not floors:
        floors = [await create_floor(db, star.id, "1 этаж")]
    for channel in sorted(unplaced, key=lambda c: (c.position, c.created_at)):
        if channel.floor_id is None:
            await place_room(db, channel, floors[0])
    await db.commit()
    return floors

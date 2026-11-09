"""Этажи карты офиса и расстановка комнат (работа с БД)."""

from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import office
from app.core import stars as rules
from app.core.stars import Perm
from app.models.star import Star, StarChannel, StarFloor, StarFloorAccess, StarMember

ALL, NONE = "all", "none"
FLOOR_ACCESS = (ALL, NONE)
LOBBY_KIND = "lobby"


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


async def create_floor(db: AsyncSession, star_id: str, name: str, access: str = ALL) -> StarFloor:
    max_position = (
        await db.execute(select(func.max(StarFloor.position)).where(StarFloor.star_id == star_id))
    ).scalar_one()
    floor = StarFloor(
        star_id=star_id, name=name, position=0 if max_position is None else max_position + 1, version=0,
        access=access,
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


# --- Доступ к этажам --------------------------------------------------------
#
# У этажа есть доступ по умолчанию (всем / никому) и исключения для отдельных участников.
# Владелец, админы и те, кому дали «Редактировать карту офиса», видят все этажи — иначе
# некому было бы ими управлять. Зал ожидания открыт всем: туда отправляют постучавшихся.
# Гостевые ссылки не зависят от этажей: гость попадает только в свою комнату.


def manages_floors(star: Star, member: StarMember) -> bool:
    return rules.has_perm(member.role, Perm.EDIT_MAP, star.role_permissions)


def _allowed(floor: StarFloor, override: bool | None) -> bool:
    return override if override is not None else floor.access != NONE


def room_floor_id(channel: StarChannel) -> str | None:
    """Этаж, доступ к которому нужен для комнаты; None — комната открыта всем участникам."""
    if channel.kind != "planet" or channel.room_kind == LOBBY_KIND:
        return None
    return channel.floor_id


async def hidden_by_member(
    db: AsyncSession, star: Star, members: list[StarMember] | None = None
) -> dict[str, set[str]]:
    """user_id -> этажи, которых участник не видит (пустое множество — видит все)."""
    if members is None:
        members = list((await db.execute(select(StarMember).where(StarMember.star_id == star.id))).scalars())
    if star.kind != "work":
        return {m.user_id: set() for m in members}
    floors = await list_floors(db, star.id)
    overrides: dict[tuple[str, str], bool] = {}
    if floors:
        rows = await db.execute(
            select(StarFloorAccess.floor_id, StarFloorAccess.user_id, StarFloorAccess.allowed).where(
                StarFloorAccess.floor_id.in_([f.id for f in floors]),
                StarFloorAccess.user_id.in_([m.user_id for m in members]),
            )
        )
        overrides = {(floor_id, user_id): allowed for floor_id, user_id, allowed in rows.all()}
    return {
        m.user_id: set()
        if manages_floors(star, m)
        else {f.id for f in floors if not _allowed(f, overrides.get((f.id, m.user_id)))}
        for m in members
    }


async def hidden_floor_ids(db: AsyncSession, star: Star, member: StarMember) -> set[str]:
    """Этажи, которых участник не видит и в комнаты которых не входит."""
    if star.kind != "work" or manages_floors(star, member):
        return set()
    return (await hidden_by_member(db, star, [member]))[member.user_id]


async def can_use_room(db: AsyncSession, star: Star, member: StarMember, channel: StarChannel) -> bool:
    floor_id = room_floor_id(channel)
    if star.kind != "work" or floor_id is None:
        return True
    return floor_id not in await hidden_floor_ids(db, star, member)


async def floor_audience(db: AsyncSession, star: Star, floor_id: str) -> set[str]:
    """Участники Звезды, которым этаж виден."""
    return {uid for uid, hidden in (await hidden_by_member(db, star)).items() if floor_id not in hidden}


async def floor_user_ids(db: AsyncSession, star: Star, floor: StarFloor) -> list[str]:
    """Участники с доступом к этажу — кроме тех, кто видит все этажи по роли (для настройки)."""
    members = list((await db.execute(select(StarMember).where(StarMember.star_id == star.id))).scalars())
    hidden = await hidden_by_member(db, star, members)
    return sorted(m.user_id for m in members if not manages_floors(star, m) and floor.id not in hidden[m.user_id])


async def room_audience(db: AsyncSession, channel_id: str) -> set[str] | None:
    """Кому видна комната: None — всем участникам (не рабочая Звезда, не комната, зал ожидания)."""
    channel = await db.get(StarChannel, channel_id)
    floor_id = room_floor_id(channel) if channel else None
    if not floor_id:
        return None
    star = await db.get(Star, channel.star_id)
    if not star or star.kind != "work":
        return None
    return await floor_audience(db, star, floor_id)


async def set_floor_access(db: AsyncSession, star: Star, floor: StarFloor, access: str, user_ids: set[str]) -> None:
    """Доступ по умолчанию и список участников с доступом (кроме тех, кто видит всё и так).

    Храним только исключения: на открытом этаже — кого не пускать, на закрытом — кого пускать.
    Новые участники Звезды получают доступ по умолчанию.
    """
    members = (await db.execute(select(StarMember).where(StarMember.star_id == star.id))).scalars().all()
    floor.access = access
    await db.execute(delete(StarFloorAccess).where(StarFloorAccess.floor_id == floor.id))
    for member in members:
        if manages_floors(star, member):
            continue
        allowed = member.user_id in user_ids
        if allowed != (access == ALL):
            db.add(StarFloorAccess(floor_id=floor.id, user_id=member.user_id, allowed=allowed))


async def forget_member(db: AsyncSession, star_id: str, user_id: str) -> None:
    """Ушёл из Звезды — исключения забываются: вернётся — получит доступ по умолчанию."""
    floor_ids = select(StarFloor.id).where(StarFloor.star_id == star_id)
    await db.execute(
        delete(StarFloorAccess).where(StarFloorAccess.user_id == user_id, StarFloorAccess.floor_id.in_(floor_ids))
    )

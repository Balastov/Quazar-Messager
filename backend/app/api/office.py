"""Карта офиса для Звёзд «Работа»: этажи и сохранение плана."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _broadcast, _channel_event, _forbid, _load_membership, floors_event
from app.core import floors as floors_svc
from app.core import office
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import Star, StarFloor
from app.models.user import User
from app.schemas.star import CreateFloor, LayoutOut, SaveLayout, StarFloorOut, UpdateFloor

router = APIRouter(prefix="/stars", tags=["office"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


async def _map_editor(db: AsyncSession, star_id: str, user: User) -> Star:
    star, me = await _load_membership(db, star_id, user.id)
    if star.kind != "work":
        raise HTTPException(status_code=400, detail="Карта офиса есть только у Звёзд «Работа»")
    if not rules.has_perm(me.role, Perm.EDIT_MAP, star.role_permissions):
        raise _forbid("Редактировать карту офиса могут владелец, админы и те, кому дали это право")
    return star


async def _floor(db: AsyncSession, star_id: str, floor_id: str) -> StarFloor:
    floor = await floors_svc.lock_floor(db, star_id, floor_id)
    if not floor:
        raise HTTPException(status_code=404, detail="Этаж не найден")
    return floor


@router.post("/{star_id}/floors", response_model=StarFloorOut, status_code=status.HTTP_201_CREATED)
async def create_floor(star_id: str, body: CreateFloor, current_user: CurrentUser, db: Db):
    star = await _map_editor(db, star_id, current_user)
    await floors_svc.ensure_floors(db, star)
    await db.execute(select(Star.id).where(Star.id == star_id).with_for_update())
    count = (
        await db.execute(select(func.count()).select_from(StarFloor).where(StarFloor.star_id == star_id))
    ).scalar_one()
    if count >= office.MAX_FLOORS:
        raise HTTPException(status_code=409, detail=f"Этажей может быть не больше {office.MAX_FLOORS}")
    floor = await floors_svc.create_floor(db, star_id, body.name)
    await db.commit()
    await _broadcast(db, star_id, floors_event(await floors_svc.list_floors(db, star_id)))
    return floor


@router.patch("/{star_id}/floors/{floor_id}", response_model=StarFloorOut)
async def rename_floor(star_id: str, floor_id: str, body: UpdateFloor, current_user: CurrentUser, db: Db):
    await _map_editor(db, star_id, current_user)
    floor = await _floor(db, star_id, floor_id)
    floor.name = body.name
    await db.commit()
    await _broadcast(db, star_id, floors_event(await floors_svc.list_floors(db, star_id)))
    return floor


@router.delete("/{star_id}/floors/{floor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_floor(star_id: str, floor_id: str, current_user: CurrentUser, db: Db):
    """Комнаты удаляемого этажа переезжают на первый из оставшихся."""
    await _map_editor(db, star_id, current_user)
    floor = await _floor(db, star_id, floor_id)
    others = [f for f in await floors_svc.list_floors(db, star_id) if f.id != floor_id]
    if not others:
        raise HTTPException(status_code=409, detail="Нельзя удалить единственный этаж")

    target = await floors_svc.lock_floor(db, star_id, others[0].id)
    moved = await floors_svc.floor_rooms(db, floor_id)
    for channel in moved:
        await floors_svc.place_room(db, channel, target)
    await db.delete(floor)
    await db.commit()

    for channel in moved:
        await _broadcast(db, star_id, _channel_event(channel))
    await _broadcast(db, star_id, floors_event(await floors_svc.list_floors(db, star_id)))


@router.put("/{star_id}/floors/{floor_id}/layout", response_model=LayoutOut)
async def save_layout(star_id: str, floor_id: str, body: SaveLayout, current_user: CurrentUser, db: Db):
    await _map_editor(db, star_id, current_user)
    floor = await _floor(db, star_id, floor_id)

    # Пока человек правил, план поменял кто-то другой — не затираем чужие правки.
    rooms = {c.id: c for c in await floors_svc.floor_rooms(db, floor_id)}
    if body.version != floor.version or {r.channel_id for r in body.rooms} != rooms.keys():
        raise HTTPException(
            status_code=409,
            detail="Пока вы редактировали, план этажа изменил кто-то другой. Обновите карту и повторите.",
        )

    rects = [office.Rect(r.x, r.y, r.w, r.h) for r in body.rooms]
    for room, rect in zip(body.rooms, rects):
        if error := office.layout_error(rect):
            raise HTTPException(status_code=422, detail=f"«{rooms[room.channel_id].name}»: {error}")
    if pair := office.first_overlap(rects):
        a, b = (rooms[body.rooms[i].channel_id].name for i in pair)
        raise HTTPException(status_code=422, detail=f"Комнаты «{a}» и «{b}» налезают друг на друга")

    for room in body.rooms:
        channel = rooms[room.channel_id]
        channel.map_x, channel.map_y, channel.map_w, channel.map_h = room.x, room.y, room.w, room.h
    floor.version += 1
    await db.commit()

    out = LayoutOut(floor=StarFloorOut.model_validate(floor), rooms=body.rooms)
    await _broadcast(db, star_id, {"type": "star_layout", **out.model_dump(mode="json")})
    return out


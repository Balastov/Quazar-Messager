"""Обучение: какие подсказки человек прошёл или отложил — на аккаунт, а не на устройство."""

from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.user import User

router = APIRouter(prefix="/users/me/tutorials", tags=["tutorials"])
CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

# Главный экран; Созвездие: основы, внутри Звезды, рабочая и игровая Звёзды; настройки (с ключами).
TOURS = ("main", "stars", "star", "star_work", "star_game", "settings")


class TutorialMark(BaseModel):
    # done — прошёл до конца; dismissed — «Не сейчас» или «Пропустить»: сами больше не предлагаем.
    state: Literal["done", "dismissed"]


class TutorialState(BaseModel):
    state: Literal["done", "dismissed"]
    at: datetime


@router.get("", response_model=dict[str, TutorialState])
async def list_tutorials(current_user: CurrentUser, db: Db):
    tours = (await db.execute(select(User.tutorials).where(User.id == current_user.id))).scalar_one()
    return {k: v for k, v in (tours or {}).items() if k in TOURS}


@router.put("/{tour_id}", response_model=dict[str, TutorialState])
async def mark_tutorial(tour_id: str, body: TutorialMark, current_user: CurrentUser, db: Db):
    if tour_id not in TOURS:
        raise HTTPException(status_code=404, detail="Нет такого обучения")
    # populate_existing: под блокировкой — свежие значения, а не загруженные при авторизации.
    query = select(User).where(User.id == current_user.id).with_for_update().execution_options(populate_existing=True)
    user = (await db.execute(query)).scalar_one()
    tours = dict(user.tutorials or {})
    # «Пройдено» не превращается обратно в «отложено» — повторный просмотр и пропуск его не стирают.
    if not (body.state == "dismissed" and tours.get(tour_id, {}).get("state") == "done"):
        tours[tour_id] = {"state": body.state, "at": datetime.now(timezone.utc).isoformat()}
        user.tutorials = tours
        await db.commit()
    return {k: v for k, v in tours.items() if k in TOURS}

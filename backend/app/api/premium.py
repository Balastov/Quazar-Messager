"""Quazar Premium глазами самого пользователя: состояние, лимиты и пробный месяц."""
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import premium
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.star import Star
from app.models.user import User

router = APIRouter(prefix="/premium", tags=["premium"])
Me = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


class PremiumLimits(BaseModel):
    free: int = premium.FREE_STARS
    trial: int = premium.TRIAL_STARS
    premium: int = premium.PREMIUM_STARS


class PremiumInfo(BaseModel):
    active: bool
    kind: str | None
    forever: bool
    until: datetime | None
    trial_available: bool
    # Почему пробный месяц недоступен — показываем как есть.
    trial_unavailable_reason: str | None
    trial_days: int = premium.TRIAL_DAYS
    # Своё ограничение Звёзд сейчас; None — без ограничения.
    star_limit: int | None
    owned_stars: int
    star_limits: PremiumLimits = PremiumLimits()


async def _info(db: AsyncSession, user: User) -> PremiumInfo:
    current = premium.state(user)
    reason = await premium.trial_unavailable(db, user)
    owned = (await db.execute(select(func.count()).select_from(Star).where(Star.owner_id == user.id))).scalar_one()
    return PremiumInfo(active=current.active, kind=current.kind, forever=current.forever, until=current.until,
                       trial_available=reason is None, trial_unavailable_reason=reason,
                       star_limit=premium.star_limit(user), owned_stars=owned)


@router.get("", response_model=PremiumInfo)
async def my_premium(me: Me, db: Db):
    return await _info(db, me)


@router.post("/trial", response_model=PremiumInfo)
async def start_trial(me: Me, db: Db):
    await premium.start_trial(db, me)
    user = await db.get(User, me.id)
    await db.refresh(user)
    return await _info(db, user)

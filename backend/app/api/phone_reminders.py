from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import or_, update

from app.api.phone_verification import Db, Me
from app.models.user import User

router = APIRouter(tags=["phone verification"])
MSK = ZoneInfo("Europe/Moscow")


def reminder_window(stamp):
    local = stamp.astimezone(MSK)
    monday = (local - timedelta(days=local.weekday())).replace(hour=12, minute=0, second=0, microsecond=0)
    if local < monday:
        monday -= timedelta(days=7)
    return monday.astimezone(timezone.utc), (monday + timedelta(days=7)).astimezone(timezone.utc)


@router.post("/users/me/phone-verification/reminder")
async def claim_reminder(me: Me, db: Db):
    """Один еженедельный показ на аккаунт. Офлайн-пользователь получает предложение при возвращении."""
    stamp = datetime.now(timezone.utc)
    week, next_at = reminder_window(stamp)
    result = await db.execute(update(User).where(User.id == me.id, User.phone_verified_at.is_(None),
        or_(User.phone_reminder_week_at.is_(None), User.phone_reminder_week_at < week))
        .values(phone_reminder_week_at=week).returning(User.id))
    due = result.scalar_one_or_none() is not None
    await db.commit()
    return {"due": due, "next_at": next_at, "server_time": stamp}

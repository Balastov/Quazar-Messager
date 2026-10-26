"""Занятость телефона, никнейма и почты — без учёта регистра."""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User

TAKEN = {
    "phone": "Этот номер уже зарегистрирован",
    "username": "Этот никнейм уже занят",
    "email": "Эта почта уже привязана к другому аккаунту",
}


async def username_taken(db: AsyncSession, username: str, *, exclude_id: str | None = None) -> bool:
    query = select(User.id).where(func.lower(User.username) == username.lower())
    if exclude_id:
        query = query.where(User.id != exclude_id)
    return (await db.execute(query.limit(1))).first() is not None


async def email_taken(db: AsyncSession, email: str, *, exclude_id: str | None = None) -> bool:
    query = select(User.id).where(func.lower(User.email) == email.lower())
    if exclude_id:
        query = query.where(User.id != exclude_id)
    return (await db.execute(query.limit(1))).first() is not None


async def phone_taken(db: AsyncSession, phone: str) -> bool:
    return (await db.execute(select(User.id).where(User.phone == phone).limit(1))).first() is not None

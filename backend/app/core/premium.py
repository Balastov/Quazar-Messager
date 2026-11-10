"""Quazar Premium: пробный месяц, выдача из «Чёрной дыры», лимиты и напоминания от news_bot.

Покупки пока нет: кнопка «Купить» в приложении сообщает, что Premium в ранней разработке.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.premium import PremiumGrant
from app.models.user import User

TRIAL_DAYS = 30
FREE_STARS = 2
TRIAL_STARS = 3
PREMIUM_STARS = 5
MOSCOW = ZoneInfo("Europe/Moscow")
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")


def now() -> datetime:
    return datetime.now(timezone.utc)


def human_date(value: datetime) -> str:
    local = value.astimezone(MOSCOW)
    return f"{local.day} {MONTHS[local.month - 1]} {local.year}"


@dataclass(frozen=True)
class PremiumState:
    active: bool
    # trial / purchase / gift / superuser; None — Premium нет.
    kind: str | None
    # Бессрочный — суперпользователь или выдан без срока.
    forever: bool
    until: datetime | None


def state(user: User) -> PremiumState:
    if user.is_superuser:
        return PremiumState(True, "superuser", True, None)
    if not user.premium_active:
        return PremiumState(False, None, False, None)
    return PremiumState(True, user.premium_kind, user.premium_until is None, user.premium_until)


def star_limit(user: User) -> int | None:
    """Сколько своих Звёзд можно иметь; None — без ограничения (суперпользователь)."""
    if user.is_superuser:
        return None
    current = state(user)
    if not current.active:
        return FREE_STARS
    return TRIAL_STARS if current.kind == "trial" else PREMIUM_STARS


def phone_hash(phone: str) -> str:
    return hashlib.sha256(f"premium-trial:{settings.JWT_SECRET}:{phone}".encode()).hexdigest()


async def recompute(db: AsyncSession, user: User) -> None:
    """Текущее состояние в users — лучший из действующих периодов: бессрочный, затем самый долгий."""
    at = now()
    grants = (await db.execute(select(PremiumGrant).where(PremiumGrant.user_id == user.id, PremiumGrant.revoked_at.is_(None),
        PremiumGrant.starts_at <= at))).scalars().all()
    live = [g for g in grants if g.ends_at is None or g.ends_at > at]
    if not live:
        user.premium_kind, user.premium_until = None, None
        return
    forever = [g for g in live if g.ends_at is None]
    # Платный или подаренный период важнее пробного, даже если пробный длиннее.
    best = forever[0] if forever else max(live, key=lambda g: (g.kind != "trial", g.ends_at))
    user.premium_kind, user.premium_until = best.kind, best.ends_at


async def trial_unavailable(db: AsyncSession, user: User) -> str | None:
    """Почему пробный месяц недоступен; None — можно взять."""
    from app.core import zvonok

    if user.is_superuser:
        return "У вас бессрочный Quazar Premium"
    if state(user).active and state(user).kind != "trial":
        return "Quazar Premium уже действует"
    used = (await db.execute(select(PremiumGrant.id).where(PremiumGrant.kind == "trial",
        (PremiumGrant.user_id == user.id) | (PremiumGrant.phone_hash == phone_hash(user.phone))))).first()
    if used:
        return "Пробный месяц уже использован — он даётся один раз на аккаунт и номер телефона"
    if zvonok.required() and user.phone_verified_at is None:
        return "Сначала подтвердите номер телефона: «Настройки → Аккаунт и вход»"
    return None


async def start_trial(db: AsyncSession, user: User) -> None:
    user = (await db.execute(select(User).where(User.id == user.id).with_for_update())).scalar_one()
    reason = await trial_unavailable(db, user)
    if reason:
        raise HTTPException(status_code=409, detail=reason)
    at = now()
    db.add(PremiumGrant(user_id=user.id, kind="trial", starts_at=at, ends_at=at + timedelta(days=TRIAL_DAYS),
                        phone_hash=phone_hash(user.phone)))
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Пробный месяц уже использован — он даётся один раз на аккаунт и номер телефона")
    await recompute(db, user)
    await db.commit()


async def grant(db: AsyncSession, user: User, months: int | None, by: User) -> None:
    """Выдача из «Чёрной дыры»: на N месяцев (по 30 дней) от текущего конца Premium или бессрочно."""
    at = now()
    current = state(user)
    if months is None:
        ends = None
    else:
        start = current.until if current.active and current.kind != "trial" and current.until else at
        ends = start + timedelta(days=30 * months)
    db.add(PremiumGrant(user_id=user.id, kind="gift", starts_at=at, ends_at=ends, created_by_id=by.id))
    await db.flush()
    await recompute(db, user)
    await db.commit()


async def revoke(db: AsyncSession, user: User, by: User) -> None:
    """Снять Premium: все действующие периоды. Пробный месяц повторно не выдаётся."""
    await db.execute(update(PremiumGrant).where(PremiumGrant.user_id == user.id, PremiumGrant.revoked_at.is_(None))
                     .values(revoked_at=now(), revoked_by_id=by.id))
    await recompute(db, user)
    await db.commit()


REMINDERS = (
    # За сколько до конца, ключ и текст напоминания о пробном месяце.
    (timedelta(days=3), "3d", "Пробный Quazar Premium закончится через 3 дня — {date}. После этого снова можно будет создавать до {free} Звёзд; уже созданные Звёзды останутся и продолжат работать."),
    (timedelta(days=1), "1d", "Пробный Quazar Premium заканчивается: остался последний день (до {date}). Уже созданные Звёзды останутся с вами и после."),
)
ENDED = ("Пробный Quazar Premium закончился. Теперь можно создавать до {free} Звёзд; уже созданные остались и работают. "
         "Купить Premium пока нельзя — он в ранней разработке. Мы напишем здесь, когда покупка появится.")


async def remind(db: AsyncSession) -> int:
    """Планировщик: напоминания о конце пробного месяца — сообщением от news_bot, каждое один раз."""
    from app.core import news

    at = now()
    queued = 0
    trials = (await db.execute(select(PremiumGrant).where(PremiumGrant.kind == "trial", PremiumGrant.revoked_at.is_(None),
        PremiumGrant.ends_at > at - timedelta(days=2), PremiumGrant.ends_at <= at + timedelta(days=3)))).scalars().all()
    for trial in trials:
        user = await db.get(User, trial.user_id)
        # Купил или получил Premium — о пробном не напоминаем.
        if user is None or (user.premium_kind and user.premium_kind != "trial" and user.premium_active) or user.is_superuser:
            continue
        if trial.ends_at <= at:
            queued += await news.notify(db, user.id, f"premium-trial-ended:{trial.id}", ENDED.format(free=FREE_STARS))
            continue
        left = trial.ends_at - at
        for window, key, template in REMINDERS:
            # Самое близкое к концу напоминание; пропущенные ранние не догоняем.
            if left <= window and (window == REMINDERS[-1][0] or left > REMINDERS[-1][0]):
                queued += await news.notify(db, user.id, f"premium-trial-{key}:{trial.id}",
                                            template.format(date=human_date(trial.ends_at), free=FREE_STARS))
                break
    await db.commit()
    return queued

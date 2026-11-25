"""Вход по коду: Quazar_Admin_bot присылает 5 цифр на устройства, где человек уже вошёл.

Код подходит только к той попытке, которая его запросила (токен попытки знает лишь новое
устройство). Подбор ограничен: 3 неверных ввода на код, не больше 10 неверных вводов и
10 кодов в сутки на аккаунт, новый код — не чаще раза в минуту. Каждый запрос виден владельцу
сообщением бота, так что попытки войти без его ведома не проходят незаметно.
"""

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import auth_log, device_sessions as sessions, support
from app.core.config import settings
from app.core.device_pairing import rate_limit
from app.models.device import DeviceSession, LoginCode
from app.models.user import User

log = logging.getLogger(__name__)
TTL = timedelta(minutes=5)
RESEND_AFTER = timedelta(seconds=60)
MAX_ATTEMPTS = 3
HOURLY_CODES = 5
DAILY_CODES = 10
DAILY_FAILURES = 10
NO_ACCOUNT = "Не удалось войти по этому номеру. Проверьте номер или создайте аккаунт"
TOO_MANY_FAILURES = "Слишком много неверных кодов. Войдите звонком или по QR-коду либо попробуйте завтра"


def now() -> datetime:
    return datetime.now(timezone.utc)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def code_digest(row_id: str, code: str) -> str:
    return hmac.new(settings.JWT_SECRET.encode(), f"login-code:{row_id}:{code}".encode(), hashlib.sha256).hexdigest()


def new_code() -> str:
    return f"{secrets.randbelow(100_000):05d}"


def code_text(code: str, device: str) -> str:
    return (
        f"Код для входа в Quazar: **{code}**\n\n"
        f"Вход запрошен на устройстве «{device}». Код действует 5 минут.\n"
        "Никому не сообщайте его — даже сотрудникам Quazar. "
        "Если вы не входили, ничего не делайте: без кода войти нельзя."
    )


def used_text(device: str) -> str:
    return (
        f"По коду из этого сообщения выполнен вход на устройстве «{device}».\n"
        "Если это были не вы — завершите тот сеанс: «Настройки → Безопасность»."
    )


def can_sign_in(user: User | None) -> bool:
    return bool(user and user.is_active and not user.blocked_at and not user.is_official)


async def failures_today(db: AsyncSession, user_id: str) -> int:
    return (await db.execute(select(func.coalesce(func.sum(LoginCode.attempts), 0)).where(
        LoginCode.user_id == user_id, LoginCode.created_at >= now() - timedelta(days=1)))).scalar_one()


async def has_signed_in_device(db: AsyncSession, user: User) -> bool:
    query = select(DeviceSession.id).where(DeviceSession.user_id == user.id, DeviceSession.revoked_at.is_(None),
                                           DeviceSession.expires_at > now())
    if sessions.cutoff(user):
        query = query.where(DeviceSession.issued_at >= sessions.cutoff(user))
    return (await db.execute(query.limit(1))).first() is not None


async def start(db: AsyncSession, phone: str, ip: str, device: str) -> tuple[LoginCode, str]:
    await rate_limit(db, "login-code", ip, limit=5)
    user = (await db.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
    if not can_sign_in(user):
        raise HTTPException(status_code=400, detail=NO_ACCOUNT)
    # Одновременные запросы одного аккаунта — по очереди, иначе лимиты можно обойти.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": "quazar-login-code:" + user.id})
    stamp = now()
    recent = list((await db.execute(select(LoginCode.created_at).where(
        LoginCode.user_id == user.id, LoginCode.created_at >= stamp - timedelta(days=1), LoginCode.state != "failed"))).scalars())
    if await failures_today(db, user.id) >= DAILY_FAILURES:
        raise HTTPException(status_code=429, detail=TOO_MANY_FAILURES)
    last = max(recent, default=None)
    if last and stamp - last < RESEND_AFTER:
        wait = max(1, int((RESEND_AFTER - (stamp - last)).total_seconds()))
        raise HTTPException(status_code=429, detail=f"Код уже отправлен. Новый можно запросить через {wait} с")
    if len(recent) >= DAILY_CODES or sum(1 for at in recent if at >= stamp - timedelta(hours=1)) >= HOURLY_CODES:
        raise HTTPException(status_code=429, detail="Слишком много запросов кода. Войдите звонком или по QR-коду")
    if not await has_signed_in_device(db, user):
        raise HTTPException(status_code=409, detail="Код приходит на устройства, где вы уже вошли, а таких нет. Войдите звонком")
    # Действует только последний код: прежние больше не подходят.
    await db.execute(update(LoginCode).where(LoginCode.user_id == user.id, LoginCode.state == "pending").values(state="replaced"))
    code, token = new_code(), secrets.token_urlsafe(32)
    row = LoginCode(user_id=user.id, token_hash=digest(token), code_hash="", device_name=device,
                    ip_hash=digest(settings.JWT_SECRET + ":" + ip), created_at=stamp, expires_at=stamp + TTL)
    db.add(row)
    await db.flush()
    row.code_hash = code_digest(row.id, code)
    await db.commit()
    try:
        message = await support.bot_notice(db, user, code_text(code, device))
    except Exception:
        await db.rollback()
        await db.execute(update(LoginCode).where(LoginCode.id == row.id).values(state="failed"))
        await db.commit()
        raise HTTPException(status_code=503, detail="Не удалось отправить код. Попробуйте позже") from None
    row.message_id = message.id
    await db.commit()
    return row, token


async def complete(db: AsyncSession, token: str, code: str, ip: str) -> str:
    await rate_limit(db, "login-code-check", ip, limit=10)
    row = (await db.execute(select(LoginCode).where(LoginCode.token_hash == digest(token)).with_for_update()
                            .execution_options(populate_existing=True))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Запросите код заново")
    if row.state == "used":
        raise HTTPException(status_code=410, detail="Код уже использован. Запросите новый")
    if row.state == "locked":
        raise HTTPException(status_code=429, detail="Слишком много неверных попыток. Запросите новый код")
    if row.state != "pending":
        raise HTTPException(status_code=410, detail="Этот код больше не действует. Запросите новый")
    if row.expires_at <= now():
        raise HTTPException(status_code=410, detail="Код истёк. Запросите новый")
    user = (await db.execute(select(User).where(User.id == row.user_id).with_for_update()
                             .execution_options(populate_existing=True))).scalar_one_or_none()
    if not can_sign_in(user):
        raise HTTPException(status_code=403, detail="Вход недоступен")
    if await failures_today(db, user.id) >= DAILY_FAILURES:
        raise HTTPException(status_code=429, detail=TOO_MANY_FAILURES)
    if not hmac.compare_digest(row.code_hash, code_digest(row.id, code)):
        row.attempts += 1
        left = MAX_ATTEMPTS - row.attempts
        if left <= 0:
            row.state = "locked"
        await db.commit()
        if left <= 0:
            raise HTTPException(status_code=429, detail="Слишком много неверных попыток. Запросите новый код")
        raise HTTPException(status_code=400, detail=f"Неверный код. Осталось попыток: {left}")
    row.state, row.used_at = "used", now()
    target, access_token = await sessions.create(db, user, row.device_name)
    await db.commit()
    await auth_log.login(db, user.id, target.id, "login_code", row.device_name)
    if row.message_id:
        # Код в чате больше не нужен — на его месте остаётся отметка о входе.
        try:
            await support.rewrite_bot_notice(db, row.message_id, used_text(row.device_name))
        except Exception:  # noqa: BLE001 — вход уже состоялся, отметка не главное
            log.exception("login code notice rewrite failed")
    return access_token


async def cleanup(db: AsyncSession) -> int:
    result = await db.execute(delete(LoginCode).where(LoginCode.created_at < now() - timedelta(days=2)))
    await db.commit()
    return result.rowcount

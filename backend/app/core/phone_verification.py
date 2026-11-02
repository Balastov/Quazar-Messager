"""Одноразовые проверки телефона; защита от повторного использования и лишних запросов к провайдеру."""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, func, select, text

from app.core import zvonok
from app.core.config import settings
from app.models.phone_verification import PhoneVerification
from app.models.user import User

TTL = timedelta(minutes=5)
POLL_SECONDS = 4


def now():
    return datetime.now(timezone.utc)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


async def start(db, phone, ip, user_id=None, *, purpose=None):
    purpose = purpose or ("verify" if user_id else "register")
    if not zvonok.configured():
        raise HTTPException(status_code=503, detail="Подтверждение телефона сейчас недоступно")
    # Общий лимит сохраняется при рестартах и работает между процессами сервера.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('quazar-phone-verification-start'))"))
    stamp = now()
    await db.execute(delete(PhoneVerification).where(PhoneVerification.created_at < stamp - timedelta(days=7)))
    ip_hash = digest(settings.JWT_SECRET + ":" + ip)
    async def count(*conditions):
        return (await db.execute(select(func.count()).select_from(PhoneVerification).where(*conditions))).scalar_one()
    if await count(PhoneVerification.created_at >= stamp.replace(hour=0, minute=0, second=0, microsecond=0)) >= settings.ZVONOK_DAILY_LIMIT:
        raise HTTPException(status_code=429, detail="Дневной лимит проверок исчерпан. Попробуйте завтра")
    if (await count(PhoneVerification.ip_hash == ip_hash, PhoneVerification.created_at >= stamp - timedelta(hours=1)) >= 20
            or await count(PhoneVerification.phone == phone, PhoneVerification.created_at >= stamp - timedelta(hours=1)) >= 5
            or await count(PhoneVerification.phone == phone, PhoneVerification.purpose == purpose,
                           PhoneVerification.created_at >= stamp - timedelta(seconds=60))):
        raise HTTPException(status_code=429, detail="Слишком много попыток. Повторите проверку позже")
    token = secrets.token_urlsafe(32)
    attempt = PhoneVerification(token_hash=digest(token), phone=phone, user_id=user_id, purpose=purpose, ip_hash=ip_hash,
        campaign_id=settings.ZVONOK_CAMPAIGN_ID, created_at=stamp, expires_at=stamp + TTL)
    db.add(attempt)
    await db.flush()
    try:
        created = await zvonok.create(phone)
    except zvonok.ProviderError:
        attempt.state = "failed"
        await db.commit()
        raise HTTPException(status_code=503, detail="Не удалось начать проверку телефона. Попробуйте позже") from None
    previous = (await db.execute(select(PhoneVerification.id).where(PhoneVerification.call_id == created.call_id))).scalar_one_or_none()
    if previous or created.created_at < stamp - timedelta(seconds=15):
        # Провайдер повторно выдаёт call_id незаконченной проверки. Другой браузер
        # не должен получить новое подтверждение на основании того же звонка.
        attempt.state = "failed"
        await db.commit()
        raise HTTPException(status_code=409, detail="Проверка этого номера уже запущена. Вернитесь к ней или повторите позже")
    attempt.call_id, attempt.call_phone = created.call_id, created.call_phone
    await db.commit()
    return attempt, token


async def status(db, token, user_id=None, *, purpose=None):
    purpose = purpose or ("verify" if user_id else "register")
    attempt = (await db.execute(select(PhoneVerification).where(PhoneVerification.token_hash == digest(token))
        .with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if not attempt or attempt.purpose != purpose or (purpose != "login" and attempt.user_id != user_id):
        raise HTTPException(status_code=404, detail="Проверка не найдена")
    stamp = now()
    if attempt.used_at or attempt.expires_at <= stamp:
        return attempt, "expired"
    if attempt.state != "pending":
        return attempt, attempt.state
    if attempt.checked_at and stamp - attempt.checked_at < timedelta(seconds=POLL_SECONDS):
        return attempt, "pending"
    if attempt.campaign_id != settings.ZVONOK_CAMPAIGN_ID:
        raise HTTPException(status_code=410, detail="Начните проверку заново")
    attempt.checked_at = stamp
    try:
        state = await zvonok.result(attempt.call_id, attempt.phone)
    except zvonok.ProviderError:
        await db.commit()  # Не даём частым повторам превращаться в шквал запросов.
        raise HTTPException(status_code=503, detail="Не удалось проверить результат звонка. Повторите позже") from None
    attempt.state = state
    closed_recoveries = []
    if state == "verified":
        attempt.verified_at = stamp
        if user_id and purpose == "verify":
            user = (await db.execute(select(User).where(User.id == user_id).with_for_update()
                .execution_options(populate_existing=True))).scalar_one()
            if user.phone != attempt.phone:
                raise HTTPException(status_code=409, detail="Номер изменился. Начните проверку заново")
            if not user.phone_verified_at:
                # Метка после получения блокировки: параллельный старый парольный вход
                # мог закончиться, пока мы ждали User. Его токен тоже нужно отозвать.
                confirmed_at = now()
                user.phone_verified_at = confirmed_at
                user.sessions_revoked_at = confirmed_at
                from app.core.passwords import complete_recoveries
                closed_recoveries = await complete_recoveries(db, user, phone_verified=True)
    await db.commit()
    if closed_recoveries:
        from app.core.support import notify_team
        for ticket in closed_recoveries:
            await notify_team(db, ticket)
    return attempt, state


async def consume(db, phone, token, *, purpose="register", user_id=None):
    attempt = None
    if token:
        attempt = (await db.execute(select(PhoneVerification).where(PhoneVerification.token_hash == digest(token))
            .with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if (not attempt or attempt.purpose != purpose or attempt.user_id != user_id or attempt.phone != phone or attempt.state != "verified"
            or not attempt.verified_at or attempt.used_at or attempt.expires_at <= now()):
        raise HTTPException(status_code=400, detail="Подтвердите телефон звонком" if purpose == "register" else "Подтвердите действие свежим звонком")
    attempt.used_at = now()
    # Коммит вместе с аккаунтом: неудачная регистрация не расходует подтверждение.
    return attempt.verified_at

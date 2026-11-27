"""Одноразовые проверки телефона; защита от повторного использования и лишних запросов к провайдеру."""

import asyncio
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, func, select, text

from app.core import telegram_gateway, zvonok
from app.core.config import settings
from app.core.phone import uses_call_check
from app.models.phone_verification import PhoneVerification
from app.models.user import User

TTL = timedelta(minutes=5)
POLL_SECONDS = 4
CODE_ATTEMPTS = 5
_reports = set()  # Ссылки на фоновые отчёты Gateway, чтобы задачи не собрал сборщик мусора.


def now():
    return datetime.now(timezone.utc)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def code_digest(token, code):
    # В базе только HMAC с токеном браузера: утечка таблицы не позволяет перебрать коды.
    return hmac.new(settings.JWT_SECRET.encode(), f"{token}:{code}".encode(), hashlib.sha256).hexdigest()


def method_for(phone):
    """+7 — звонок. Остальные — код в Telegram, а пока Telegram Gateway не настроен — тоже звонок
    (временная мера: звонок из-за границы платный, и номер звонящего может не дойти)."""
    return "telegram" if not uses_call_check(phone) and telegram_gateway.configured() else "call"


async def start(db, phone, ip, user_id=None, *, purpose=None):
    purpose = purpose or ("verify" if user_id else "register")
    method = method_for(phone)
    if method == "call" and not zvonok.configured():
        raise HTTPException(status_code=503, detail="Подтверждение телефона сейчас недоступно")
    # Общий лимит сохраняется при рестартах и работает между процессами сервера.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('quazar-phone-verification-start'))"))
    stamp = now()
    await db.execute(delete(PhoneVerification).where(PhoneVerification.created_at < stamp - timedelta(days=7)))
    ip_hash = digest(settings.JWT_SECRET + ":" + ip)
    async def count(*conditions):
        return (await db.execute(select(func.count()).select_from(PhoneVerification).where(*conditions))).scalar_one()
    daily_limit = settings.ZVONOK_DAILY_LIMIT if method == "call" else settings.TELEGRAM_GATEWAY_DAILY_LIMIT
    if await count(PhoneVerification.method == method,
                   PhoneVerification.created_at >= stamp.replace(hour=0, minute=0, second=0, microsecond=0)) >= daily_limit:
        raise HTTPException(status_code=429, detail="Дневной лимит проверок исчерпан. Попробуйте завтра")
    if (await count(PhoneVerification.ip_hash == ip_hash, PhoneVerification.created_at >= stamp - timedelta(hours=1)) >= 20
            or await count(PhoneVerification.phone == phone, PhoneVerification.created_at >= stamp - timedelta(hours=1)) >= 5
            or await count(PhoneVerification.phone == phone, PhoneVerification.purpose == purpose,
                           PhoneVerification.created_at >= stamp - timedelta(seconds=60))):
        raise HTTPException(status_code=429, detail="Слишком много попыток. Повторите проверку позже")
    token = secrets.token_urlsafe(32)
    attempt = PhoneVerification(token_hash=digest(token), phone=phone, user_id=user_id, purpose=purpose, ip_hash=ip_hash,
        method=method, campaign_id=settings.ZVONOK_CAMPAIGN_ID if method == "call" else "telegram",
        created_at=stamp, expires_at=stamp + TTL)
    db.add(attempt)
    await db.flush()
    if method == "telegram":
        code = f"{secrets.randbelow(1_000_000):06d}"
        attempt.code_hash = code_digest(token, code)
        try:
            request_id = await telegram_gateway.send_code(phone, code, int(TTL.total_seconds()))
        except telegram_gateway.Undeliverable:
            attempt.state = "failed"
            await db.commit()
            raise HTTPException(status_code=400, detail="Не удалось отправить код в Telegram. Проверьте, что к этому номеру привязан аккаунт Telegram") from None
        except telegram_gateway.ProviderError:
            attempt.state = "failed"
            await db.commit()
            raise HTTPException(status_code=503, detail="Не удалось отправить код в Telegram. Попробуйте позже") from None
        attempt.call_id = "tg:" + request_id
        await db.commit()
        return attempt, token
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


async def status(db, token, user_id=None, *, purpose=None, code=None):
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
    if attempt.method == "telegram":
        if code is None:
            return attempt, "pending"
        attempt.code_attempts += 1
        if not hmac.compare_digest(attempt.code_hash or "", code_digest(token, code)):
            left = CODE_ATTEMPTS - attempt.code_attempts
            if left <= 0:
                attempt.state = "failed"
            await db.commit()
            if left <= 0:
                return attempt, "failed"
            raise HTTPException(status_code=400, detail=f"Неверный код. Осталось попыток: {left}")
        state = "verified"
        task = asyncio.create_task(telegram_gateway.report_code(attempt.call_id.removeprefix("tg:"), code))
        _reports.add(task)
        task.add_done_callback(_reports.discard)
    else:
        if code is not None:
            raise HTTPException(status_code=400, detail="Для этой проверки код не нужен: дождитесь звонка")
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
    revoked_all = None
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
                revoked_all = user.id
                from app.core.passwords import complete_recoveries
                closed_recoveries = await complete_recoveries(db, user, phone_verified=True)
    await db.commit()
    if revoked_all:
        from app.core import auth_log
        await auth_log.record(db, "revoked", user_id=revoked_all, reason="phone_verified",
                              detail="Все прежние входы завершены; устройство, где подтверждали, получило новый токен")
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
        raise HTTPException(status_code=400, detail="Подтвердите телефон" if purpose == "register" else "Подтвердите действие ещё раз")
    attempt.used_at = now()
    # Коммит вместе с аккаунтом: неудачная регистрация не расходует подтверждение.
    return attempt.verified_at

import hashlib
import math
import uuid
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import auth_log
from app.core.security import create_access_token, token_claims, token_is_current
from app.core.config import settings
from app.models.device import DeviceSession
from app.models.user import User
from app.ws.hub import manager


def now() -> datetime:
    return datetime.now(timezone.utc)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def cutoff(user: User) -> datetime | None:
    return max((value for value in (user.password_changed_at, user.sessions_revoked_at) if value), default=None)


def idle_deadline() -> datetime:
    """До какого момента сессия живёт без заходов."""
    return now() + timedelta(days=settings.SESSION_IDLE_DAYS)


def token_deadline(issued_at: datetime) -> datetime:
    """Срок в самом токене — целые секунды, как его хранит JWT."""
    return (issued_at + timedelta(minutes=settings.JWT_ACCESS_EXPIRE_MINUTES)).replace(microsecond=0)


def stamp(user: User) -> str:
    value = cutoff(user)
    epoch = hashlib.sha256((settings.JWT_ALGORITHM + ":" + settings.JWT_SECRET).encode()).hexdigest()[:16]
    return (value.isoformat() if value else "") + ":" + epoch


def device_name(agent: str) -> str:
    browser = next((name for marker, name in [("Electron", "Quazar Desktop"), ("Edg/", "Edge"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")] if marker in agent), "Браузер")
    platform = next((name for marker, name in [("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Windows", "Windows"), ("Mac", "macOS"), ("Linux", "Linux")] if marker in agent), "")
    return f"{browser} · {platform}" if platform else browser


async def ensure(db: AsyncSession, token: str, user: User, agent: str = "") -> DeviceSession:
    # Срок в токене не проверяем: сессия живёт, пока устройством пользуются (см. ниже).
    claims = token_claims(token, verify_exp=False)
    token_hash = digest(token)
    if not claims or claims.get("sub") != user.id:
        await auth_log.rejected(db, "bad_token", token_hash=token_hash, user_id=user.id)
        raise HTTPException(status_code=401, detail="Сессия завершена. Войдите снова")
    if not token_is_current(token, user):
        reason, detail = auth_log.cutoff_reason(user)
        await auth_log.rejected(db, reason, token_hash=token_hash, user_id=user.id, session_id=claims.get("sid"), detail=detail)
        raise HTTPException(status_code=401, detail="Сессия завершена. Войдите снова")
    try:
        issued, expires = float(claims["iat"]), float(claims["exp"])
        if not math.isfinite(issued) or not math.isfinite(expires):
            raise ValueError()
        issued_at, expires_at = datetime.fromtimestamp(issued, timezone.utc), datetime.fromtimestamp(expires, timezone.utc)
    except (KeyError, ValueError, OverflowError, TypeError):
        await auth_log.rejected(db, "bad_token", token_hash=token_hash, user_id=user.id)
        raise HTTPException(status_code=401, detail="Некорректная сессия") from None
    sid = claims.get("sid")
    row = (await db.execute(select(DeviceSession).where(DeviceSession.token_hash == token_hash).execution_options(populate_existing=True))).scalar_one_or_none()
    if row is None and not sid:
        # Токен без записи сессии (вход паролем, Яндексом…) регистрируется, только пока не истёк сам.
        if expires_at <= now():
            await auth_log.rejected(db, "token_expired", token_hash=token_hash, user_id=user.id,
                                    detail=f"Токен выдан {auth_log.when(issued_at)}, истёк {auth_log.when(expires_at)}")
            raise HTTPException(status_code=401, detail="Сессия завершена. Войдите снова")
        name = device_name(agent[:1024])
        created = (await db.execute(insert(DeviceSession).values(id=str(uuid.uuid4()), user_id=user.id, token_hash=token_hash,
            name=name, created_at=issued_at, issued_at=issued_at, last_seen_at=now(),
            expires_at=idle_deadline(), token_expires_at=expires_at)
            .on_conflict_do_nothing(index_elements=[DeviceSession.token_hash]).returning(DeviceSession.id))).scalar_one_or_none()
        await db.commit()
        row = (await db.execute(select(DeviceSession).where(DeviceSession.token_hash == token_hash))).scalar_one()
        if created:
            # Первый заход с токеном, выданным без записи сессии (пароль, Яндекс, звонок…): это и есть вход.
            await auth_log.login(db, user.id, created, str(claims.get("amr") or "unknown"), name)
    problem = None
    if row is None:
        problem = ("session_missing", None)
    elif row.user_id != user.id or (sid and row.id != sid):
        problem = ("session_mismatch", None)
    elif row.revoked_at:
        problem = ("session_revoked", f"Завершён {auth_log.when(row.revoked_at)}, устройство: {row.name}")
    elif row.expires_at <= now():
        problem = ("session_expired", f"Последний заход {auth_log.when(row.last_seen_at)}, устройство: {row.name}")
    if problem:
        await auth_log.rejected(db, problem[0], token_hash=token_hash, user_id=user.id,
                                session_id=row.id if row else sid, detail=problem[1])
        raise HTTPException(status_code=401, detail="Сессия завершена. Войдите снова")
    if row.last_seen_at < now() - timedelta(minutes=1):
        # Заход продлевает сессию: выйти придётся, только если устройством не пользовались SESSION_IDLE_DAYS.
        row.last_seen_at = now()
        row.expires_at = max(row.expires_at, idle_deadline())
        await db.commit()
    return row


async def create(db: AsyncSession, user: User, name: str, expires_at: datetime | None = None) -> tuple[DeviceSession, str]:
    # Способ входа сюда не кладём: token_for пересобирает этот токен и сверяет хэш. Вход в журнал пишет вызывающий.
    sid = str(uuid.uuid4())
    issued_at = now()
    expires_at = min(expires_at or idle_deadline(), idle_deadline())
    jti = secrets.token_urlsafe(24)
    token = create_access_token(user.id, sid, issued_at=issued_at, expires_at=token_deadline(issued_at), jti=jti)
    claims = token_claims(token)
    row = DeviceSession(id=sid, user_id=user.id, token_hash=digest(token), token_jti=jti, name=name,
        created_at=now(), issued_at=datetime.fromtimestamp(claims["iat"], timezone.utc), last_seen_at=now(),
        expires_at=expires_at, token_expires_at=datetime.fromtimestamp(claims["exp"], timezone.utc))
    db.add(row)
    return row, token


def token_for(row: DeviceSession) -> str:
    if not row.token_jti:
        raise HTTPException(status_code=410, detail="Подключение больше недоступно")
    token = create_access_token(row.user_id, row.id, issued_at=row.issued_at,
                                expires_at=row.token_expires_at or row.expires_at, jti=row.token_jti)
    if digest(token) != row.token_hash:
        raise HTTPException(status_code=410, detail="Подключение больше недоступно")
    return token


async def close_connections(user_id: str, session_id: str | None = None, *, except_id: str | None = None) -> None:
    for ws in list(manager.user_connections.get(user_id, [])):
        current = getattr(ws, "_quazar_session_id", None)
        if (session_id is None or current == session_id) and (except_id is None or current != except_id):
            try:
                await ws.close(code=4001)
            except Exception:
                pass


async def cleanup(db: AsyncSession) -> int:
    result = await db.execute(delete(DeviceSession).where(DeviceSession.expires_at < now() - timedelta(days=1)))
    await db.commit()
    return result.rowcount

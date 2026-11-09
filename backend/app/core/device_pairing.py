"""Short-lived, explicitly approved device pairing. Private keys never reach the server."""
import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import device_sessions as sessions
from app.core.config import settings
from app.models.device import DevicePairing, DevicePairLimit, DeviceSession
from app.models.user import User

TTL = timedelta(minutes=2)
# Ключи просит устройство, где уже вошли: второе устройство ещё нужно найти и открыть.
KEYS_TTL = timedelta(minutes=5)
APPROVED_TTL = timedelta(minutes=1)
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def now() -> datetime:
    return datetime.now(timezone.utc)


def validate_key(value: str) -> str:
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) != 32 or base64.b64encode(raw).decode() != value:
            raise ValueError()
        # Reject low-order public keys as well as invalid encodings.
        X25519PrivateKey.from_private_bytes(bytes(range(32))).exchange(X25519PublicKey.from_public_bytes(raw))
    except (ValueError, TypeError):
        raise ValueError("Некорректный ключ устройства") from None
    return value


def binding(row: DevicePairing) -> str:
    fields = ["quazar-device-v1", row.id, row.receiver_public_key, row.approver_public_key,
              row.user_id, row.account_public_key or "", row.device_name]
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


async def rate_limit(db: AsyncSession, scope: str, identity: str, limit: int = 12) -> None:
    bucket = now().replace(second=0, microsecond=0)
    key = scope + ":" + hmac.new(settings.JWT_SECRET.encode(), identity.encode(), hashlib.sha256).hexdigest()
    count = (await db.execute(insert(DevicePairLimit).values(key=key, bucket=bucket, hits=1)
        .on_conflict_do_update(index_elements=[DevicePairLimit.key, DevicePairLimit.bucket],
            set_={"hits": DevicePairLimit.hits + 1}).returning(DevicePairLimit.hits))).scalar_one()
    await db.commit()
    if count > limit:
        raise HTTPException(status_code=429, detail="Слишком много попыток. Повторите через минуту")


async def get_pair(db: AsyncSession, pair_id: str, *, lock: bool = False) -> DevicePairing:
    query = select(DevicePairing).where(DevicePairing.id == pair_id).execution_options(populate_existing=True)
    if lock:
        query = query.with_for_update()
    row = (await db.execute(query)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запрос подключения не найден")
    return row


def active(row: DevicePairing) -> None:
    if row.expires_at <= now():
        raise HTTPException(status_code=410, detail="Время подключения истекло. Создайте новый QR-код")
    if row.state == "rejected":
        raise HTTPException(status_code=410, detail="Подключение отменено")


def receiver(row: DevicePairing, secret: str) -> None:
    if not row.receiver_secret_hash or not hmac.compare_digest(row.receiver_secret_hash, sessions.digest(secret)):
        raise HTTPException(status_code=404, detail="Запрос подключения не найден")


async def source(db: AsyncSession, user_id: str, session_id: str) -> tuple[User, DeviceSession]:
    user = (await db.execute(select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    session = (await db.execute(select(DeviceSession).where(DeviceSession.id == session_id).with_for_update()
        .execution_options(populate_existing=True))).scalar_one_or_none()
    if (not user or user.blocked_at or user.is_official or not session or session.user_id != user_id or
        session.revoked_at or session.expires_at <= now() or (sessions.cutoff(user) and session.issued_at < sessions.cutoff(user))):
        raise HTTPException(status_code=401, detail="Подтверждающая сессия завершена. Войдите снова")
    return user, session


async def bound_source(db: AsyncSession, row: DevicePairing) -> User:
    user, _ = await source(db, row.user_id, row.approver_session_id)
    if sessions.stamp(user) != row.security_stamp or user.public_key != row.account_public_key:
        raise HTTPException(status_code=409, detail="Настройки безопасности изменились. Начните подключение заново")
    return user


async def start_request(db: AsyncSession, public_key: str, secret: str, name: str) -> tuple[DevicePairing, str]:
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    row = DevicePairing(kind="request", state="pending", code_hash=sessions.digest(code),
        receiver_public_key=public_key, receiver_secret_hash=sessions.digest(secret), device_name=name,
        expires_at=now() + TTL)
    db.add(row)
    await db.commit()
    return row, code


async def start_key_request(db: AsyncSession, user_id: str, session_id: str, public_key: str, secret: str,
                            name: str) -> tuple[DevicePairing, str]:
    """Устройство, где уже вошли, просит ключ переписки у другого своего устройства — без нового входа."""
    user, session = await source(db, user_id, session_id)
    if not user.public_key:
        raise HTTPException(status_code=409, detail="У аккаунта ещё нет ключа шифрования")
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    row = DevicePairing(kind="keys", state="pending", code_hash=sessions.digest(code), user_id=user.id,
        target_session_id=session.id, receiver_public_key=public_key, receiver_secret_hash=sessions.digest(secret),
        device_name=name, expires_at=now() + KEYS_TTL)
    db.add(row)
    await db.commit()
    return row, code


async def create_invite(db: AsyncSession, user_id: str, session_id: str, public_key: str) -> tuple[DevicePairing, str]:
    user, session = await source(db, user_id, session_id)
    secret = secrets.token_urlsafe(32)
    row = DevicePairing(kind="invite", state="offered", user_id=user.id, approver_session_id=session.id,
        approver_public_key=public_key, invite_secret_hash=sessions.digest(secret), device_name="Новое устройство",
        account_public_key=user.public_key, security_stamp=sessions.stamp(user), expires_at=now() + TTL)
    db.add(row)
    await db.commit()
    return row, secret


async def accept_invite(db: AsyncSession, pair_id: str, invite_secret: str, expected_key: str,
                        public_key: str, receiver_secret: str, name: str) -> DevicePairing:
    row = await get_pair(db, pair_id, lock=True)
    if row.kind != "invite" or not row.invite_secret_hash or not hmac.compare_digest(row.invite_secret_hash, sessions.digest(invite_secret)):
        raise HTTPException(status_code=404, detail="Приглашение не найдено")
    active(row)
    if row.approver_public_key != expected_key:
        raise HTTPException(status_code=409, detail="Ключ приглашения не совпадает")
    if row.state != "offered" and row.receiver_public_key == public_key and row.receiver_secret_hash and hmac.compare_digest(row.receiver_secret_hash, sessions.digest(receiver_secret)):
        await bound_source(db, row)
        return row
    if row.state != "offered":
        raise HTTPException(status_code=409, detail="Приглашение уже использовано. Создайте новое")
    await bound_source(db, row)
    row.receiver_public_key = public_key
    row.receiver_secret_hash = sessions.digest(receiver_secret)
    row.device_name = name
    row.state = "claimed"
    await db.commit()
    return row


async def claim(db: AsyncSession, user_id: str, session_id: str, public_key: str, *, pair_id: str | None,
                code: str | None, expected_key: str | None) -> DevicePairing:
    if code:
        code = code.replace("-", "").replace(" ", "").upper()
        pair_id = (await db.execute(select(DevicePairing.id).where(DevicePairing.code_hash == sessions.digest(code)))).scalar_one_or_none()
    if not pair_id:
        raise HTTPException(status_code=404, detail="Код не найден или истёк")
    row = await get_pair(db, pair_id, lock=True)
    if row.kind == "keys" and row.user_id != user_id:
        # Чужой запрос ключей не должен даже подтверждаться как существующий.
        raise HTTPException(status_code=404, detail="Код не найден или истёк")
    active(row)
    if row.kind not in ("request", "keys") or row.state not in ("pending", "claimed"):
        raise HTTPException(status_code=409, detail="Запрос уже обработан")
    if row.kind == "keys" and row.target_session_id == session_id:
        raise HTTPException(status_code=409, detail="Этот код нужно ввести на другом устройстве, где переписка уже читается")
    if row.state == "claimed":
        if row.user_id == user_id and row.approver_session_id == session_id and row.approver_public_key == public_key:
            return row
        raise HTTPException(status_code=409, detail="Запрос уже открыт на другом устройстве. Создайте новый QR-код")
    if expected_key and row.receiver_public_key != expected_key:
        raise HTTPException(status_code=409, detail="Ключ QR-кода не совпадает")
    user, session = await source(db, user_id, session_id)
    row.user_id, row.approver_session_id = user.id, session.id
    row.approver_public_key = public_key
    row.account_public_key, row.security_stamp = user.public_key, sessions.stamp(user)
    row.state = "claimed"
    await db.commit()
    return row


async def approve(db: AsyncSession, pair_id: str, user_id: str, session_id: str, code_binding: str,
                  encrypted_keys: dict | None, allow_without_keys: bool) -> DevicePairing:
    row = await get_pair(db, pair_id, lock=True)
    active(row)
    if row.user_id != user_id or row.approver_session_id != session_id:
        raise HTTPException(status_code=404, detail="Запрос подключения не найден")
    if row.state != "claimed":
        raise HTTPException(status_code=409, detail="Запрос уже обработан")
    user = await bound_source(db, row)
    if not hmac.compare_digest(code_binding, binding(row)):
        raise HTTPException(status_code=409, detail="Код сравнения не совпадает. Начните заново")
    if row.kind == "keys" and encrypted_keys is None:
        raise HTTPException(status_code=422, detail="На этом устройстве нет ключа переписки — передать нечего")
    if user.public_key and encrypted_keys is None and not allow_without_keys:
        raise HTTPException(status_code=422, detail="Подтвердите вход без переноса ключей переписки")
    if not user.public_key and encrypted_keys is not None:
        raise HTTPException(status_code=422, detail="Ключ аккаунта не найден")
    row.encrypted_keys = encrypted_keys
    row.approved_at, row.expires_at, row.state = now(), now() + APPROVED_TTL, "approved"
    await db.commit()
    return row


async def consume(db: AsyncSession, pair_id: str, secret: str) -> tuple[DevicePairing, str]:
    row = await get_pair(db, pair_id, lock=True)
    receiver(row, secret)
    if row.kind == "keys":
        # Запрос ключей не выдаёт новую сессию: устройство уже вошло.
        raise HTTPException(status_code=404, detail="Запрос подключения не найден")
    active(row)
    if row.state not in ("approved", "consumed"):
        raise HTTPException(status_code=409, detail="Подтвердите вход на авторизованном устройстве")
    user = await bound_source(db, row)
    if row.state == "consumed":
        target = await db.get(DeviceSession, row.target_session_id)
        if not target or target.revoked_at or target.expires_at <= now():
            raise HTTPException(status_code=410, detail="Сессия уже завершена")
        return row, sessions.token_for(target)
    approving_session = await db.get(DeviceSession, row.approver_session_id)
    target, token = await sessions.create(db, user, row.device_name, approving_session.expires_at)
    await db.flush([target])
    row.target_session_id, row.consumed_at, row.state = target.id, now(), "consumed"
    await db.commit()
    return row, token


async def consume_keys(db: AsyncSession, pair_id: str, secret: str, user_id: str, session_id: str) -> DevicePairing:
    row = await get_pair(db, pair_id, lock=True)
    receiver(row, secret)
    if row.kind != "keys" or row.user_id != user_id or row.target_session_id != session_id:
        raise HTTPException(status_code=404, detail="Запрос ключей не найден")
    active(row)
    if row.state not in ("approved", "consumed") or not row.encrypted_keys:
        raise HTTPException(status_code=409, detail="Подтвердите передачу ключей на другом устройстве")
    await bound_source(db, row)
    if row.state == "approved":
        row.consumed_at, row.state = now(), "consumed"
        await db.commit()
    return row


async def cleanup(db: AsyncSession) -> int:
    await db.execute(update(DevicePairing).where(DevicePairing.expires_at < now(), DevicePairing.encrypted_keys.is_not(None)).values(encrypted_keys=None))
    result = await db.execute(delete(DevicePairing).where(DevicePairing.expires_at < now() - timedelta(days=1)))
    await db.execute(delete(DevicePairLimit).where(DevicePairLimit.bucket < now() - timedelta(hours=1)))
    await db.commit()
    return result.rowcount

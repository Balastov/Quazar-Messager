"""Revocable device sessions and short-lived cross-device authorization requests."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DeviceSession(Base):
    __tablename__ = "device_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    token_jti: Mapped[str | None] = mapped_column(String(64), nullable=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Сессия завершается после SESSION_IDLE_DAYS без заходов; каждый заход сдвигает срок.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    # Срок, записанный в самом токене: по нему токен восстанавливается (token_for), сессию он не ограничивает.
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Какой ключ переписки устройство сообщило в последний раз (публичный, не секрет);
    # null при e2e_reported_at — сообщило, что ключа аккаунта у него нет.
    e2e_public_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    e2e_reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DevicePairing(Base):
    __tablename__ = "device_pairings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # request / invite / keys
    state: Mapped[str] = mapped_column(String(16), nullable=False)  # offered / pending / claimed / approved / consumed / rejected
    code_hash: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    invite_secret_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    receiver_secret_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    receiver_public_key: Mapped[str | None] = mapped_column(String(44), nullable=True)
    approver_public_key: Mapped[str | None] = mapped_column(String(44), nullable=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    approver_session_id: Mapped[str | None] = mapped_column(ForeignKey("device_sessions.id", ondelete="SET NULL"), nullable=True)
    target_session_id: Mapped[str | None] = mapped_column(ForeignKey("device_sessions.id", ondelete="SET NULL"), nullable=True)
    account_public_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    security_stamp: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    device_name: Mapped[str] = mapped_column(String(160), nullable=False)
    encrypted_keys: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Сверка числом (запрос ключей): новое устройство заранее фиксирует случайное число хэшем,
    # подтверждающее присылает своё, и лишь потом новое раскрывает своё — подобрать совпадение нельзя.
    commitment: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approver_nonce: Mapped[str | None] = mapped_column(String(44), nullable=True)
    receiver_nonce: Mapped[str | None] = mapped_column(String(44), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DevicePairLimit(Base):
    __tablename__ = "device_pair_limits"
    key: Mapped[str] = mapped_column(String(96), primary_key=True)
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    hits: Mapped[int] = mapped_column(Integer, nullable=False)


class LoginCode(Base):
    """Вход по коду от Quazar_Admin_bot: код приходит на устройства, где уже вошли."""
    __tablename__ = "login_codes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # Токен попытки знает только устройство, которое просило код: чужой код к нему не подойдёт.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    device_name: Mapped[str] = mapped_column(String(160), nullable=False)
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending / used / locked / replaced / failed
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # неверные вводы
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

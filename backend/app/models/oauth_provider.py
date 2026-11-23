"""Квазар как провайдер входа (OAuth 2.0 Authorization Code + PKCE) — сейчас для Padma.

Не путать с OAuthFlow в user.py: там Квазар — клиент Яндекса. Подробности — docs/PADMA-SSO.md.
Коды и токены хранятся только как SHA-256: утечка базы не даёт ими воспользоваться.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OAuthCode(Base):
    """Одноразовый код авторизации: 120 секунд, привязан к клиенту, адресу возврата и PKCE."""

    __tablename__ = "oauth_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    redirect_uri: Mapped[str] = mapped_column(String(512), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    code_challenge: Mapped[str] = mapped_column(String(128), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    # Обменян на токен. Повторный обмен отзывает выданный токен.
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class OAuthAccessToken(Base):
    """Токен доступа клиента: 5 минут, годится только для /oauth/userinfo."""

    __tablename__ = "oauth_access_tokens"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.profile import display_name


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Никнейм латиницей (app/core/profile.py); уникален без учёта регистра — индекс в main.py.
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    phone: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    # Необязательные: почта (в нижнем регистре, уникальна) и имя для отображения на любом языке.
    email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Можно ли найти по номеру (поиск, телефонная книга) и видеть номер. None — ещё не выбрал:
    # клиент спросит при входе, а пока номер скрыт.
    phone_discoverable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Нет (None) — аккаунт создан через внешний вход (Яндекс) и пароля пока не задали.
    password_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Личный фон приложения (/media/backgrounds/…); видит только сам пользователь.
    background_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    public_key_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    key_backup: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Когда закрылось последнее соединение (для «был(а) в сети …»).
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Ручной статус: "meeting" (на встрече) | "dnd" (не беспокоить); until — до какого момента
    # (None — пока не снимут).
    manual_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    manual_status_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Свой рабочий график {"days", "start", "end", "tz"} — поверх общего графика Звезды.
    work_schedule: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Свой статус: {"icon": имя значка, "text": до 80 символов, "until": ISO | None}.
    custom_status: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Владелец ресурса: «Чёрная дыра», власть в любой Звезде, без лимитов. Никому, кроме таких же,
    # не показывается: в ответах API о других людях этого поля нет.
    is_superuser: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Официальный аккаунт Квазара (Quazar_Admin_bot): зелёный значок, в поиске его нет,
    # написать ему можно только через «Обратную связь».
    is_official: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Заблокирован на всём ресурсе: не войти, сессии закрыты.
    blocked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    blocked_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    memberships: Mapped[list["ChatMember"]] = relationship("ChatMember", back_populates="user")  # noqa: F821

    @property
    def has_password(self) -> bool:
        return bool(self.password_hash)

    @property
    def visible_phone(self) -> str | None:
        """Номер глазами других: только если разрешили находить по нему."""
        return self.phone if self.phone_discoverable else None

    @property
    def display_name(self) -> str:
        return display_name(self.first_name, self.last_name, self.username)


class UserIdentity(Base):
    """Внешний вход, привязанный к аккаунту: provider («yandex») и id человека у провайдера."""

    __tablename__ = "user_identities"
    __table_args__ = (UniqueConstraint("provider", "subject"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    subject: Mapped[str] = mapped_column(String(64), nullable=False)
    # Почта и логин у провайдера — только для подписи в настройках («Яндекс: anna@yandex.ru»).
    email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    login: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class OAuthFlow(Base):
    """Один вход через внешнего провайдера: от редиректа до выдачи сессии (минуты).

    state — в адресе к провайдеру; verifier — PKCE. После ответа провайдера появляется
    одноразовый handoff-код: по нему клиент забирает сессию или данные для регистрации."""

    __tablename__ = "oauth_flows"

    state: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    verifier: Mapped[str] = mapped_column(String(128), nullable=False)
    # login — войти или зарегистрироваться; link — привязать к уже вошедшему user_id.
    mode: Mapped[str] = mapped_column(String(8), nullable=False)
    # web | mobile — куда вернуть человека.
    client: Mapped[str] = mapped_column(String(8), nullable=False, default="web")
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    handoff: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True, index=True)
    # Мобильное приложение: sha256(секрет приложения) в base64url. Вернувшийся по quazar://
    # код меняют на сессию только с этим секретом — перехватившее ссылку приложение его не знает.
    client_challenge: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Профиль у провайдера (для регистрации) — до завершения.
    profile: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

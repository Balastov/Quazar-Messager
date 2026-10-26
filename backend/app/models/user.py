import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    phone: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
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
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    memberships: Mapped[list["ChatMember"]] = relationship("ChatMember", back_populates="user")  # noqa: F821

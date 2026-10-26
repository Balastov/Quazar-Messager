from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NotifySetting(Base):
    """Уровень уведомлений пользователя для чата, Звезды или Спутника.

    level: all | mentions | none; NULL — как уровнем выше (Спутник → Звезда → по умолчанию).
    muted_until — временно без уведомлений (счётчики непрочитанного всё равно растут).
    """

    __tablename__ = "notify_settings"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    # chat | star | channel
    scope: Mapped[str] = mapped_column(String(8), primary_key=True)
    target_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    level: Mapped[str | None] = mapped_column(String(8), nullable=True)
    muted_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

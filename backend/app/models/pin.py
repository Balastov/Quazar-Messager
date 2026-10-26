from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ChatPin(Base):
    """Закреплённое сообщение чата (удалили сообщение — закреп уходит вместе с ним)."""

    __tablename__ = "chat_pins"

    chat_id: Mapped[str] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), primary_key=True)
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True)
    pinned_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarPin(Base):
    """Закреплённое сообщение Спутника."""

    __tablename__ = "star_pins"

    channel_id: Mapped[str] = mapped_column(ForeignKey("star_channels.id", ondelete="CASCADE"), primary_key=True)
    message_id: Mapped[str] = mapped_column(ForeignKey("star_messages.id", ondelete="CASCADE"), primary_key=True)
    star_id: Mapped[str] = mapped_column(ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True)
    pinned_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

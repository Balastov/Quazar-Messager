"""Release announcements and a durable, per-user delivery queue."""
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NewsRelease(Base):
    __tablename__ = "news_releases"

    version: Mapped[str] = mapped_column(String(32), primary_key=True)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class NewsInbox(Base):
    __tablename__ = "news_inboxes"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), unique=True, nullable=False)


class NewsDelivery(Base):
    __tablename__ = "news_deliveries"

    version: Mapped[str] = mapped_column(ForeignKey("news_releases.version", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    message_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

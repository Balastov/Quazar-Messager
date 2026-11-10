"""Release announcements, a durable per-user delivery queue and personal notices from the news bot."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NewsRelease(Base):
    """Новость об обновлении. Деплой создаёт черновик; всем она уходит только после одобрения в «Чёрной дыре»."""

    __tablename__ = "news_releases"

    version: Mapped[str] = mapped_column(String(32), primary_key=True)
    # Текст сообщения в том виде, как его получат люди (для черновика — предпросмотр).
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    # draft — ждёт одобрения; published — разослана; skipped — решили не публиковать;
    # merged — вошла в черновик более новой версии (merged_into).
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="published")
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    changes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Версии, о которых рассказывает новость (несколько — если черновики объединились).
    versions: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Растёт с каждой правкой: публикуется ровно тот текст, который видел одобряющий.
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    merged_into: Mapped[str | None] = mapped_column(String(32), nullable=True)


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


class NewsNotice(Base):
    """Личное сообщение от news_bot одному человеку: черновик ждёт проверки, заканчивается пробный Premium."""

    __tablename__ = "news_notices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Повод и адресат: одно и то же напоминание не уйдёт дважды.
    key: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    message_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

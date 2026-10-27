"""Обратная связь: предложения, вопросы и ошибки — обращения к команде Квазара.

Обращение живёт в чате человека с Quazar_Admin_bot (тип чата support, без E2E): там его
карточка, ответы команды и смена статуса. В «Чёрной дыре» — список обращений с перепиской.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Identity, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SupportTicket(Base):
    __tablename__ = "support_tickets"
    # Номер выдаёт база (identity) — забираем его сразу при вставке.
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Номер для людей: «Обращение №12».
    number: Mapped[int] = mapped_column(Integer, Identity(), unique=True, nullable=False)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chat_id: Mapped[str] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    # Карточка в чате (или первое сообщение, если человек просто написал боту).
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    # idea | question | bug
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Картинки — как в сообщении «IMG1:»: id вложения, ключ, тип и размеры. Файлы удаляются через
    # 30 дней (app.core.attachments), ссылки остаются — клиент пишет «Картинка удалена».
    images: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # queued | in_progress | done
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    # Последнее событие: сообщение в переписке или смена статуса.
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class SupportMessage(Base):
    """Сообщение чата поддержки, относящееся к обращению: переписка по нему в «Чёрной дыре»."""

    __tablename__ = "support_messages"

    message_id: Mapped[str] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Кто из команды написал от имени бота (None — человек или сам бот).
    admin_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

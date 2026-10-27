import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Chat(Base):
    __tablename__ = "chats"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # saved — «Избранное»: чат с самим собой (один участник), всегда E2E.
    type: Mapped[str] = mapped_column(
        Enum("direct", "group", "saved", name="chat_type"), nullable=False
    )
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)  # только для групп
    # Общий фон чата: «IMG1:{…}» со ссылкой на вложение и ключом к нему, в личных чатах —
    # зашифрованный E2E для обоих (сервер его не читает). Вложение-картинка не удаляется
    # уборкой, пока на него ссылается чат.
    background: Mapped[str | None] = mapped_column(Text, nullable=True)
    background_attachment_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # Исчезающие сообщения: сколько секунд живёт новое сообщение (None — не исчезают).
    ttl_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    members: Mapped[list["ChatMember"]] = relationship("ChatMember", back_populates="chat")
    messages: Mapped[list["Message"]] = relationship("Message", back_populates="chat", order_by="Message.created_at")  # noqa: F821


class ChatMember(Base):
    __tablename__ = "chat_members"

    chat_id: Mapped[str] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(
        Enum("owner", "admin", "member", name="member_role"), default="member"
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    # Прочитал всё, что пришло до этого момента. Нужен группам: статус сообщения там общий
    # на всех, а непрочитанные у каждого свои. В личных чатах хватает статуса сообщения.
    last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=lambda: datetime.now(timezone.utc)
    )

    chat: Mapped["Chat"] = relationship("Chat", back_populates="members")
    user: Mapped["User"] = relationship("User", back_populates="memberships")  # noqa: F821

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Call(Base):
    """Persisted call records. Active signaling state lives in-memory (ws/calls)."""

    __tablename__ = "calls"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    chat_id: Mapped[str] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True)
    caller_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    callee_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # audio today; video / audio_video later without schema break
    media: Mapped[str] = mapped_column(
        Enum("audio", "video", "audio_video", name="call_media"),
        default="audio",
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        Enum(
            "ringing",
            "active",
            "ended",
            "missed",
            "rejected",
            "failed",
            "busy",
            name="call_status",
        ),
        default="ringing",
        nullable=False,
        index=True,
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_sec: Mapped[int | None] = mapped_column(Integer, nullable=True)

    chat: Mapped["Chat"] = relationship("Chat")  # noqa: F821
    caller: Mapped["User"] = relationship("User", foreign_keys=[caller_id])  # noqa: F821
    callee: Mapped["User"] = relationship("User", foreign_keys=[callee_id])  # noqa: F821

"""Счётчики расходов ASR и общий текст встреч; аудио и ключи здесь не хранятся."""
from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class TranscriptionUsage(Base):
    __tablename__ = "transcription_usage"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    bucket: Mapped[str] = mapped_column(String(48), primary_key=True)
    seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    requests: Mapped[int] = mapped_column(Integer, nullable=False)


class RecordingTranscript(Base):
    """Одна общая расшифровка на запись встречи; доступ проверяется по исходному файлу."""
    __tablename__ = "recording_transcripts"

    recording_id: Mapped[str] = mapped_column(ForeignKey("room_recordings.id", ondelete="CASCADE"), primary_key=True)
    requested_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", index=True)
    total_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processed_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

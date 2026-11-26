"""Суточные счётчики расходов. Аудио, ключи и текст здесь не хранятся."""
from datetime import date

from sqlalchemy import Date, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class TranscriptionUsage(Base):
    __tablename__ = "transcription_usage"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    bucket: Mapped[str] = mapped_column(String(48), primary_key=True)
    seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    requests: Mapped[int] = mapped_column(Integer, nullable=False)

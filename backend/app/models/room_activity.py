"""Общие активности голосовой комнаты. Доска и часы сохраняются после переподключения."""

from sqlalchemy import Float, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RoomActivity(Base):
    __tablename__ = "room_activities"

    channel_id: Mapped[str] = mapped_column(ForeignKey("star_channels.id", ondelete="CASCADE"), primary_key=True)
    star_id: Mapped[str] = mapped_column(ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pointers_sharer_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    board: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    focus: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    video: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class RoomVideo(Base):
    __tablename__ = "room_videos"

    file_id: Mapped[str] = mapped_column(ForeignKey("star_files.id", ondelete="CASCADE"), primary_key=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("star_channels.id", ondelete="CASCADE"), nullable=False, index=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)

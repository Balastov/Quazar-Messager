"""Запись встречи в комнате рабочей Звезды (видео: звук + показ экрана; отдельно — звуковая дорожка).

Пишет браузер того, кто включил запись, и шлёт файлы кусками; сервер дописывает их в файлы Звезды
(MEDIA_ROOT/star_files/<id>) и после остановки кладёт сообщение «Запись встречи» в чат комнаты.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RoomRecording(Base):
    __tablename__ = "room_recordings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True)
    channel_id: Mapped[str] = mapped_column(
        ForeignKey("star_channels.id", ondelete="CASCADE"), nullable=False, index=True
    )
    started_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # recording — идёт; finished — готова (сообщение в чате); expired — файлы удалены через 90 дней.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="recording", index=True)
    # Подпись для имён файлов в местном времени включившего («21.11 14:00»).
    label: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_chunk_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Файлы — id будущих StarFile (сами строки появляются при завершении).
    video_file_id: Mapped[str] = mapped_column(String(36), nullable=False, default=_uuid)
    audio_file_id: Mapped[str] = mapped_column(String(36), nullable=False, default=_uuid)
    video_mime: Mapped[str] = mapped_column(String(64), nullable=False, default="video/webm")
    audio_mime: Mapped[str] = mapped_column(String(64), nullable=False, default="audio/webm")
    video_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    audio_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    # Номер следующего ожидаемого куска: куски идут по порядку, повтор уже принятого — не ошибка.
    video_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    audio_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("star_messages.id", ondelete="SET NULL"), nullable=True
    )

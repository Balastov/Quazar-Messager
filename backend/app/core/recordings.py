"""Запись встреч в комнатах рабочих Звёзд.

Пишет браузер того, кто включил запись (у сервера нет ресурсов на запись в LiveKit Egress): видео —
звук всей комнаты и показ экрана, отдельно — только звук (для расшифровки). Файлы приходят кусками
по порядку (PUT …/recordings/{id}/{video|audio}?seq=N) и дописываются в файлы Звезды на диске.

Остановили, включивший вышел из комнаты или пропал больше чем на STALE_AFTER — запись завершается:
файлы переупаковываются ffmpeg без перекодирования (браузерная WebM без длительности и меток плохо
перематывается), становятся файлами Звезды и уходят сообщением «Запись встречи» в чат комнаты. Видят
те же, кто видит чат комнаты. Через RETENTION файлы удаляются, сообщение остаётся с пометкой.

Все в комнате видят «Идёт запись»: флаг recording у включившего в присутствии комнаты (voice).
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import room_chat, star_files, voice
from app.core import stars as rules
from app.models.recording import RoomRecording
from app.models.transcription import RecordingTranscript
from app.models.star import Star, StarChannel, StarFile, StarMember, StarMessage
from app.models.user import User

log = logging.getLogger(__name__)

MAX_CHUNK_BYTES = 16 * 1024 * 1024
MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024
MAX_AUDIO_BYTES = 512 * 1024 * 1024
MAX_DURATION = timedelta(hours=4)
# Включивший пропал (закрыл вкладку, нет связи): столько ждём новых кусков, прежде чем завершить.
STALE_AFTER = timedelta(minutes=2)
RETENTION = timedelta(days=90)
# Запись начинается, только если у Звезды осталось хотя бы столько места под файлы.
MIN_QUOTA_LEFT = 200 * 1024 * 1024

KINDS = ("video", "audio")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def can_record(star: Star, me: StarMember, channel: StarChannel) -> bool:
    """Включают модераторы, админы, владелец Звезды и главный в комнате — только в рабочих Звёздах."""
    if star.kind != "work" or not room_chat.has_chat(channel):
        return False
    return rules.is_staff(me.role) or voice.host(channel.id) == me.user_id


def inside(channel_id: str, user_id: str | None) -> bool:
    return any(p.user_id == user_id for p in voice.participants(channel_id))


async def active(db: AsyncSession, channel_id: str) -> RoomRecording | None:
    return (
        await db.execute(
            select(RoomRecording).where(RoomRecording.channel_id == channel_id, RoomRecording.status == "recording")
        )
    ).scalars().first()


def file_id(rec: RoomRecording, kind: str) -> str:
    return rec.video_file_id if kind == "video" else rec.audio_file_id


def _append(path, data: bytes) -> None:
    with path.open("ab") as f:
        f.write(data)


async def append_chunk(db: AsyncSession, rec: RoomRecording, kind: str, seq: int, data: bytes) -> str:
    """Дописать кусок. «ok» — принят, «dup» — уже был (повтор после обрыва), иначе — номер, который ждём."""
    expected = rec.video_seq if kind == "video" else rec.audio_seq
    if seq < expected:
        return "dup"
    if seq > expected:
        return str(expected)
    size = rec.video_bytes if kind == "video" else rec.audio_bytes
    if size + len(data) > (MAX_VIDEO_BYTES if kind == "video" else MAX_AUDIO_BYTES):
        raise ValueError("too large")
    await asyncio.to_thread(_append, star_files.file_path(file_id(rec, kind)), data)
    if kind == "video":
        rec.video_seq, rec.video_bytes = seq + 1, size + len(data)
    else:
        rec.audio_seq, rec.audio_bytes = seq + 1, size + len(data)
    rec.last_chunk_at = _now()
    await db.commit()
    return "ok"


def _remux(path, mime: str) -> None:
    """Переупаковать без перекодирования: длительность и метки для перемотки. Нет ffmpeg — как есть."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not path.is_file() or path.stat().st_size == 0:
        return
    mp4 = mime.endswith("/mp4")
    tmp = path.with_name(path.name + (".remux.mp4" if mp4 else ".remux.webm"))
    args = [ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", str(path), "-c", "copy"]
    args += ["-movflags", "+faststart", "-f", "mp4"] if mp4 else ["-f", "webm"]
    try:
        subprocess.run([*args, str(tmp)], check=True, timeout=1800, capture_output=True)
        if tmp.is_file() and tmp.stat().st_size > 0:
            tmp.replace(path)
    except (subprocess.SubprocessError, OSError) as exc:
        log.warning("recording remux failed (%s), keeping the original", type(exc).__name__)
    finally:
        tmp.unlink(missing_ok=True)


def _file_name(rec: RoomRecording, room: str, kind: str, mime: str) -> str:
    ext = "mp4" if mime.endswith("/mp4") else "webm"
    when = f" {rec.label}" if rec.label else ""
    what = "видео" if kind == "video" else "звук"
    return star_files.clean_name(f"Запись «{room}»{when} — {what}.{ext}".replace(":", "-"))


async def set_flag(star_id: str, channel_id: str, user_id: str | None, on: bool) -> None:
    """«Идёт запись» у включившего — в присутствии комнаты, его видят все внутри."""
    if user_id:
        await voice.set_recording(star_id, channel_id, user_id, on)


async def finish(db: AsyncSession, rec: RoomRecording, reason: str) -> None:
    """Завершить запись: файлы — в файлы Звезды, сообщение «Запись встречи» — в чат комнаты."""
    from app.api.stars import _broadcast, _messages_out

    if rec.status != "recording":
        return
    rec.status = "finished"
    rec.ended_at = _now()
    await db.commit()
    await set_flag(rec.star_id, rec.channel_id, rec.started_by, False)
    log.info("recording %s finished (%s)", rec.id, reason)

    channel = await db.get(StarChannel, rec.channel_id)
    room = channel.name if channel else "Комната"
    files: list[StarFile] = []
    for kind in KINDS:
        fid, mime = file_id(rec, kind), (rec.video_mime if kind == "video" else rec.audio_mime)
        path = star_files.file_path(fid)
        if not path.is_file() or path.stat().st_size == 0:
            star_files.delete_file(fid)
            continue
        await asyncio.to_thread(_remux, path, mime)
        files.append(StarFile(id=fid, star_id=rec.star_id, channel_id=rec.channel_id, uploader_id=rec.started_by,
                              name=_file_name(rec, room, kind, mime), mime=mime, size=path.stat().st_size))
    if not files:
        rec.status = "empty"
        await db.commit()
        return

    message = StarMessage(star_id=rec.star_id, channel_id=rec.channel_id, sender_id=rec.started_by,
                          text="Запись встречи", kind="recording", ref_id=rec.id)
    db.add(message)
    await db.flush()
    for f in files:
        f.message_id = message.id
        db.add(f)
    rec.message_id = message.id
    await db.commit()
    user = await db.get(User, rec.started_by) if rec.started_by else None
    out = (await _messages_out(db, [(message, user)]))[0]
    await _broadcast(db, rec.star_id, {"type": "star_message", "message": out.model_dump(mode="json")})


async def on_participant_left(db: AsyncSession, channel_id: str, user_id: str | None) -> None:
    """Включивший вышел из комнаты — запись кончилась (что успело прийти, то и сохраняем)."""
    rec = await active(db, channel_id)
    if rec and rec.started_by == user_id:
        await finish(db, rec, "left")


async def sweep(db: AsyncSession, now: datetime | None = None) -> int:
    """Пропавшие и слишком долгие записи — завершить; записи старше RETENTION — удалить файлы.
    Заодно вернуть «Идёт запись» в присутствие после перезапуска бэкенда."""
    now = now or _now()
    done = 0
    for rec in (await db.execute(select(RoomRecording).where(RoomRecording.status == "recording"))).scalars().all():
        quiet = now - (rec.last_chunk_at or rec.started_at)
        if now - rec.started_at > MAX_DURATION or (quiet > STALE_AFTER and not inside(rec.channel_id, rec.started_by)) \
                or quiet > MAX_DURATION:
            await finish(db, rec, "stale")
            done += 1
        elif inside(rec.channel_id, rec.started_by):
            await set_flag(rec.star_id, rec.channel_id, rec.started_by, True)
    old = (
        await db.execute(
            select(RoomRecording).where(RoomRecording.status == "finished", RoomRecording.started_at < now - RETENTION)
        )
    ).scalars().all()
    for rec in old:
        await db.execute(delete(RecordingTranscript).where(RecordingTranscript.recording_id == rec.id))
        for fid in (rec.video_file_id, rec.audio_file_id):
            file = await db.get(StarFile, fid)
            if file:
                await db.delete(file)
            star_files.delete_file(fid)
        rec.status = "expired"
        done += 1
    if old:
        await db.commit()
    return done

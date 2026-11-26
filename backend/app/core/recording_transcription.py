"""Долгие записи: очередь в PostgreSQL, последовательные части и сохранённый прогресс."""
import asyncio
import contextlib
import logging
import math
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core import recordings, star_files, transcription
from app.core.config import settings
from app.models.recording import RoomRecording
from app.models.transcription import RecordingTranscript, TranscriptionUsage
from app.models.user import User

log = logging.getLogger(__name__)
CHUNK_SECONDS = 300
MAX_SECONDS = int(recordings.MAX_DURATION.total_seconds())


async def readable_recording(db: AsyncSession, star_id: str, recording_id: str, user_id: str) -> RoomRecording:
    from app.api.star_files import _readable_file
    rec = await db.get(RoomRecording, recording_id)
    if not rec or rec.star_id != star_id:
        raise HTTPException(404, "Запись не найдена")
    # Точно те же ограничения комнат/этажей/гостей, что при скачивании звука.
    await _readable_file(db, star_id, rec.audio_file_id, user_id)
    if rec.status != "finished" or not rec.message_id:
        raise HTTPException(409, "Расшифровать можно только сохранённую запись встречи")
    path = star_files.file_path(rec.audio_file_id)
    if not path.is_file():
        raise HTTPException(404, "Звук записи уже удалён")
    return rec


def normalize(source: Path, target: Path) -> int:
    """Ограниченный полный decode: надёжная длительность даже у браузерной WebM."""
    if source.stat().st_size > recordings.MAX_AUDIO_BYTES:
        raise HTTPException(413, "Звук записи больше 512 МБ")
    if shutil.disk_usage(target.parent).free < 512 * 1024 * 1024:
        raise HTTPException(507, "Недостаточно временного места для обработки встречи")
    with source.open("rb") as stream:
        head = stream.read(12)
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        demuxer = "matroska"
    elif head.startswith(b"OggS"):
        demuxer = "ogg"
    elif head[4:8] == b"ftyp":
        demuxer = "mov"
    else:
        raise HTTPException(422, "Не удалось прочитать звуковую дорожку встречи")
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer,
             "-i", str(source), "-map", "0:a:0", "-t", str(MAX_SECONDS + 1), "-ac", "1", "-ar", "16000",
             "-sample_fmt", "s16", "-c:a", "flac", str(target)], check=True, capture_output=True, timeout=180,
        )
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(target)],
            check=True, capture_output=True, timeout=5,
        )
        duration = float(probe.stdout)
        if not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS:
            raise ValueError("duration")
        return math.ceil(duration)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise HTTPException(422, "Не удалось подготовить звук. Максимум — 4 часа") from None


def audio_chunk(source: Path, target: Path, start: int, seconds: int) -> bytes:
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe",
             "-ss", str(start), "-i", str(source), "-t", str(seconds), "-map", "0:a:0",
             "-c:a", "flac", str(target)], check=True, capture_output=True, timeout=30,
        )
        if not 0 < target.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError("size")
        return target.read_bytes()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise HTTPException(422, "Не удалось подготовить часть записи") from None


def timestamp(seconds: int) -> str:
    return f"{seconds // 3600:02}:{seconds % 3600 // 60:02}:{seconds % 60:02}"


async def process(factory: async_sessionmaker, recording_id: str) -> None:
    """Вызывается только под advisory lock; каждый успешный фрагмент сохраняется отдельно."""
    try:
        async with factory() as db:
            job = await db.get(RecordingTranscript, recording_id)
            if not job or job.status not in ("queued", "running"):
                return
            user = await db.get(User, job.requested_by) if job.requested_by else None
            if not user or user.blocked_at:
                raise HTTPException(403, "Пользователь, запросивший расшифровку, недоступен")
            rec = await db.get(RoomRecording, recording_id)
            if not rec:
                return
            await readable_recording(db, rec.star_id, rec.id, user.id)
            if job.total_seconds > 0 and job.processed_seconds >= job.total_seconds:
                job.status, job.error = "ready", None
                await db.commit()
                return
            # Не тратим CPU на повторную подготовку многочасового звука при исчерпанном бюджете.
            for bucket, minutes, max_requests in (
                ("total", settings.TRANSCRIPTION_TOTAL_MINUTES_PER_DAY, 1000),
                (f"user:{user.id}", settings.TRANSCRIPTION_USER_MINUTES_PER_DAY, 100),
            ):
                usage = await db.get(TranscriptionUsage, (datetime.now(timezone.utc).date(), bucket))
                if minutes <= 0 or (usage and (usage.seconds >= minutes * 60 or usage.requests >= max_requests)):
                    raise HTTPException(429, "Дневной лимит расшифровки исчерпан")
            star_id, user_id = rec.star_id, user.id
            source = star_files.file_path(rec.audio_file_id)
            job.status, job.error = "running", None
            await db.commit()
        # Исходный файл не загружается ни в браузер, ни целиком в RAM.
        # Дожидаемся завершения to_thread при отмене, прежде чем удалять его временные файлы.
        with tempfile.TemporaryDirectory(prefix="quazar-meeting-asr-") as folder:
            normalized, chunk = Path(folder) / "audio.flac", Path(folder) / "chunk.flac"
            total = await _prepare(normalize, source, normalized)
            async with factory() as db:
                job = await db.get(RecordingTranscript, recording_id)
                if not job:
                    return
                job.total_seconds = total
                await db.commit()
            while True:
                async with factory() as db:
                    job = await db.get(RecordingTranscript, recording_id)
                    if not job:
                        return
                    user = await db.get(User, user_id)
                    if not user or user.blocked_at:
                        raise HTTPException(403, "Доступ к расшифровке прекращён")
                    await readable_recording(db, star_id, recording_id, user_id)
                    start = job.processed_seconds
                    if start >= total:
                        job.status, job.error = "ready", None
                        await db.commit()
                        return
                seconds = min(CHUNK_SECONDS, total - start)
                audio = await _prepare(audio_chunk, normalized, chunk, start, seconds)
                async with factory() as db:
                    await transcription.reserve_usage(db, user_id, seconds)
                result = await transcription.transcribe(audio)
                async with factory() as db:
                    job = await db.get(RecordingTranscript, recording_id)
                    if not job:
                        return
                    # Проверяем доступность исходника ещё раз: запись могли удалить за время ASR.
                    await readable_recording(db, star_id, recording_id, user_id)
                    if result:
                        job.text += ("\n\n" if job.text else "") + f"[{timestamp(start)}]\n{result}"
                    job.processed_seconds = start + seconds
                    await db.commit()
    except HTTPException as exc:
        async with factory() as db:
            job = await db.get(RecordingTranscript, recording_id)
            if job:
                job.status, job.error = "failed", str(exc.detail)[:300]
                await db.commit()
    except Exception:
        # Не логируем ни текст, ни исходное аудио, ни ответ/заголовки Cloudflare.
        log.error("Meeting transcription interrupted: %s", recording_id)
        async with factory() as db:
            job = await db.get(RecordingTranscript, recording_id)
            if job:
                job.status, job.error = "failed", "Обработка прервана. Можно продолжить с сохранённого места"
                await db.commit()


async def _prepare(fn, *args):
    task = asyncio.create_task(asyncio.to_thread(fn, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await task
        raise


async def run_next(factory: async_sessionmaker) -> bool:
    if not transcription.configured():
        return False
    async with factory() as db:
        ids = (await db.execute(select(RecordingTranscript.recording_id).where(
            RecordingTranscript.status.in_(("queued", "running")),
        ).order_by(RecordingTranscript.created_at).limit(20))).scalars().all()
    for recording_id in ids:
        # Транзакционная блокировка держится в отдельной сессии, пока прогресс коммитится
        # в других. При падении процесса PostgreSQL сам освобождает блокировку.
        async with factory() as guard:
            locked = (await guard.execute(text(
                "SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"
            ), {"key": f"meeting-asr:{recording_id}"})).scalar_one()
            if locked:
                await process(factory, recording_id)
                return True
    return False


async def run_forever(factory: async_sessionmaker) -> None:
    while True:
        try:
            if await run_next(factory):
                continue
        except Exception:
            log.error("Meeting transcription queue unavailable")
        await asyncio.sleep(5)

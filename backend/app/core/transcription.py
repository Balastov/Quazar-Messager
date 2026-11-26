"""Cloudflare ASR: временные файлы удаляются, ошибки провайдера не раскрывают секреты."""
import base64
import math
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import HTTPException
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.transcription import TranscriptionUsage

MAX_BYTES = 5 * 1024 * 1024
MAX_SECONDS = 600


def configured() -> bool:
    return bool(settings.CLOUDFLARE_ACCOUNT_ID.strip() and settings.CLOUDFLARE_API_TOKEN.strip())


def prepare_audio(data: bytes) -> tuple[bytes, int]:
    """Декодируем сами: длительности из заголовка клиента доверять нельзя."""
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(413, "Голосовое должно быть не больше 5 МБ")
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        demuxer = "matroska"
    elif data.startswith(b"OggS"):
        demuxer = "ogg"
    elif data[4:8] == b"ftyp":
        demuxer = "mov"
    else:
        raise HTTPException(422, "Поддерживаются голосовые WebM, Ogg и MP4")
    with tempfile.TemporaryDirectory(prefix="quazar-asr-") as folder:
        source, target = Path(folder) / "input", Path(folder) / "audio.flac"
        source.write_bytes(data)
        try:
            subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer,
                 "-i", str(source), "-map", "0:a:0", "-t", str(MAX_SECONDS + 1),
                 "-ac", "1", "-ar", "16000", "-c:a", "flac", str(target)],
                check=True, capture_output=True, timeout=20,
            )
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(target)],
                check=True, capture_output=True, timeout=5,
            )
            duration = float(probe.stdout)
            if not math.isfinite(duration) or duration <= 0 or duration > MAX_SECONDS:
                raise ValueError("duration")
            return target.read_bytes(), max(1, math.ceil(duration))
        except (OSError, ValueError, subprocess.SubprocessError):
            raise HTTPException(422, "Не удалось прочитать звук. Максимум — 10 минут") from None


async def reserve_usage(db: AsyncSession, user_id: str, seconds: int) -> None:
    """Оба лимита резервируются атомарно и переживают перезапуск/несколько workers."""
    day = datetime.now(timezone.utc).date()
    for bucket, minutes, max_requests in (
        ("total", settings.TRANSCRIPTION_TOTAL_MINUTES_PER_DAY, 1000),
        (f"user:{user_id}", settings.TRANSCRIPTION_USER_MINUTES_PER_DAY, 100),
    ):
        if minutes <= 0 or seconds > minutes * 60:
            await db.rollback()
            raise HTTPException(429, "Дневной лимит расшифровки исчерпан")
        stmt = insert(TranscriptionUsage).values(day=day, bucket=bucket, seconds=seconds, requests=1)
        stmt = stmt.on_conflict_do_update(
            index_elements=[TranscriptionUsage.day, TranscriptionUsage.bucket],
            set_={"seconds": TranscriptionUsage.seconds + seconds,
                  "requests": TranscriptionUsage.requests + 1},
            where=(TranscriptionUsage.seconds + seconds <= minutes * 60)
            & (TranscriptionUsage.requests < max_requests),
        ).returning(TranscriptionUsage.seconds)
        if (await db.execute(stmt)).scalar_one_or_none() is None:
            await db.rollback()
            raise HTTPException(429, "Дневной лимит расшифровки исчерпан")
    # Даже неудачный вызов учитываем: провайдер мог уже обработать аудио до обрыва связи.
    await db.commit()


async def transcribe(data: bytes, *, transport: httpx.AsyncBaseTransport | None = None) -> str:
    account = settings.CLOUDFLARE_ACCOUNT_ID.strip()
    # Нельзя подставить произвольный URL или модель через клиент.
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account) or settings.CLOUDFLARE_ASR_MODEL != "@cf/openai/whisper-large-v3-turbo":
        raise HTTPException(503, "Проверьте настройки Cloudflare на сервере")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{settings.CLOUDFLARE_ASR_MODEL}"
    try:
        async with httpx.AsyncClient(timeout=45, transport=transport) as client:
            response = await client.post(
                url, headers={"Authorization": f"Bearer {settings.CLOUDFLARE_API_TOKEN.strip()}"},
                json={"audio": base64.b64encode(data).decode("ascii"), "language": "ru",
                      "task": "transcribe", "vad_filter": True},
            )
        if response.status_code == 429:
            raise HTTPException(429, "Лимит Cloudflare исчерпан. Попробуйте позже")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise ValueError("unsuccessful")
        result = payload.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise ValueError("invalid result")
        return result["text"].strip()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "Cloudflare не смог расшифровать запись. Попробуйте позже") from None

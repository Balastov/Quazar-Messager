"""Файлы Спутников: MEDIA_ROOT/star_files/<id>, отдаются только участникам Звезды через API.

В Звёздах нет сквозного шифрования (как и у текста Спутников), поэтому файл лежит как есть —
так по нему работает поиск по названию и превью картинок. Хранятся, пока живо сообщение;
у Звезды есть общий лимит места (STAR_FILES_QUOTA_MB).
"""
from __future__ import annotations

import re
import shutil
import time
import unicodedata
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

MAX_FILE_BYTES = 50 * 1024 * 1024
# Загружено, но так и не отправлено в сообщении — удаляем через сутки.
UNSENT_TTL = timedelta(hours=24)
ORPHAN_FILE_GRACE_SEC = 60 * 60
# Картинки, которые можно показать прямо в Спутнике; остальное отдаём как octet-stream.
PREVIEW_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

_SAFE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_MIME = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$")


class FileTooLarge(Exception):
    pass


class StorageFull(Exception):
    pass


def files_dir() -> Path:
    directory = Path(settings.MEDIA_ROOT).resolve() / "star_files"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def file_path(file_id: str) -> Path:
    if not _SAFE_ID.match(file_id):
        raise ValueError("Invalid file id")
    return files_dir() / file_id


def clean_name(raw: str | None) -> str:
    """Имя файла для показа и скачивания: без путей и управляющих символов, не длиннее 255."""
    name = unicodedata.normalize("NFC", raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if unicodedata.category(ch)[0] != "C").strip().strip(".")
    if not name:
        return "file"
    if len(name) > 255:
        stem, dot, ext = name.rpartition(".")
        name = (stem[: 250 - len(ext)] + dot + ext) if dot and len(ext) <= 10 else name[:255]
    return name


def clean_mime(raw: str | None) -> str:
    mime = (raw or "").split(";", 1)[0].strip().lower()
    return mime if _MIME.match(mime) else "application/octet-stream"


def ensure_free_space() -> None:
    free = shutil.disk_usage(files_dir()).free
    if free < settings.MEDIA_MIN_FREE_MB * 1024 * 1024 + MAX_FILE_BYTES:
        raise StorageFull


async def save_stream(file_id: str, chunks: AsyncIterator[bytes], limit: int = MAX_FILE_BYTES) -> int:
    path = file_path(file_id)
    tmp = path.with_suffix(".part")
    size = 0
    try:
        with tmp.open("wb") as f:
            async for chunk in chunks:
                size += len(chunk)
                if size > limit:
                    raise FileTooLarge
                f.write(chunk)
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return size


def delete_file(file_id: str) -> None:
    try:
        file_path(file_id).unlink(missing_ok=True)
    except (ValueError, OSError):
        pass


async def sweep(session: AsyncSession) -> int:
    """Неотправленные за сутки и файлы без строки в БД (удалили сообщение, канал, Звезду)."""
    from app.models.star import StarFile

    now_dt = datetime.now(timezone.utc)
    stale = set(
        (
            await session.execute(
                delete(StarFile)
                .where(StarFile.message_id.is_(None), StarFile.created_at < now_dt - UNSENT_TTL)
                .returning(StarFile.id)
            )
        ).scalars().all()
    )
    await session.commit()
    known = set((await session.execute(select(StarFile.id))).scalars().all())
    now = time.time()
    removed = 0
    for path in files_dir().iterdir():
        name = path.name.removesuffix(".part")
        if name in known:
            continue
        try:
            if now - path.stat().st_mtime < ORPHAN_FILE_GRACE_SEC and name not in stale:
                continue
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed

"""Картинки в чатах: зашифрованные клиентом файлы на диске под MEDIA_ROOT/attachments.

Клиент шифрует картинку случайным ключом (NaCl secretbox: nonce[24] || mac[16] || ciphertext)
и кладёт ключ в текст сообщения — в личных чатах тот зашифрован E2E. Сервер хранит только
шифротекст и не знает ни содержимого, ни типа картинки. Каталог не раздаётся через /media:
файл отдаёт только API и только участникам чата.
Через ATTACHMENT_TTL_DAYS (по умолчанию 30) файл удаляется; сообщение остаётся.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings

log = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 10 * 1024 * 1024
# nonce + MAC secretbox поверх исходной картинки.
ENCRYPTION_OVERHEAD = 24 + 16
MAX_ATTACHMENT_BYTES = MAX_IMAGE_BYTES + ENCRYPTION_OVERHEAD

# Загруженное, но так и не отправленное в сообщении — удаляем через сутки.
UNSENT_TTL = timedelta(hours=24)
# Файл без строки в БД моложе этого возраста может быть ещё в процессе загрузки.
ORPHAN_FILE_GRACE_SEC = 60 * 60
SWEEP_INTERVAL_SEC = 60 * 60

_SAFE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class AttachmentTooLarge(Exception):
    pass


class StorageFull(Exception):
    pass


def attachments_dir() -> Path:
    directory = Path(settings.MEDIA_ROOT).resolve() / "attachments"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def attachment_path(attachment_id: str) -> Path:
    if not _SAFE_ID.match(attachment_id):
        raise ValueError("Invalid attachment id")
    return attachments_dir() / attachment_id


def ensure_free_space() -> None:
    """Не даём картинкам занять весь диск — на нём же живут БД и логи."""
    free = shutil.disk_usage(attachments_dir()).free
    if free < settings.MEDIA_MIN_FREE_MB * 1024 * 1024 + MAX_ATTACHMENT_BYTES:
        raise StorageFull


async def save_stream(attachment_id: str, chunks: AsyncIterator[bytes]) -> int:
    """Пишет поток в файл, обрывая его на MAX_ATTACHMENT_BYTES. Возвращает размер."""
    path = attachment_path(attachment_id)
    tmp = path.with_suffix(".part")
    size = 0
    try:
        with tmp.open("wb") as f:
            async for chunk in chunks:
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    raise AttachmentTooLarge
                f.write(chunk)
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return size


def delete_file(attachment_id: str) -> None:
    try:
        attachment_path(attachment_id).unlink(missing_ok=True)
    except (ValueError, OSError):
        pass


async def sweep(session: AsyncSession) -> int:
    """Удаляет неотправленные и просроченные (старше ATTACHMENT_TTL_DAYS) вложения,
    а также файлы, чьих строк больше нет. Возвращает число удалённых файлов."""
    from app.models.attachment import Attachment

    now_dt = datetime.now(timezone.utc)
    expired = Attachment.message_id.is_(None) & (Attachment.created_at < now_dt - UNSENT_TTL)
    if settings.ATTACHMENT_TTL_DAYS > 0:
        expired = or_(
            expired, Attachment.created_at < now_dt - timedelta(days=settings.ATTACHMENT_TTL_DAYS)
        )
    stale = set(
        (await session.execute(delete(Attachment).where(expired).returning(Attachment.id)))
        .scalars()
        .all()
    )
    await session.commit()

    known = set((await session.execute(select(Attachment.id))).scalars().all())
    now = time.time()
    removed = 0
    for path in attachments_dir().iterdir():
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


async def sweep_forever(session_factory: async_sessionmaker) -> None:
    while True:
        try:
            async with session_factory() as session:
                removed = await sweep(session)
            if removed:
                log.info("attachments sweep: removed %d files", removed)
        except Exception:  # noqa: BLE001 — фоновая уборка не должна падать насовсем
            log.exception("attachments sweep failed")
        await asyncio.sleep(SWEEP_INTERVAL_SEC)

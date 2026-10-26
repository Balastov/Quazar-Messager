"""Файлы Спутников: загрузка (сырое тело запроса), раздел «Файлы» Звезды с поиском, скачивание."""

import uuid
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _load_membership, _satellite, _user_out, assert_can_post
from app.core import star_files
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.star import StarFile
from app.models.user import User
from app.schemas.star import StarFileListItem, StarFileOut

router = APIRouter(prefix="/stars", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

TOO_LARGE = "Файл больше 50 МБ"


def _quota() -> int:
    return settings.STAR_FILES_QUOTA_MB * 1024 * 1024


async def _used(db: AsyncSession, star_id: str) -> int:
    return int(
        (await db.execute(select(func.coalesce(func.sum(StarFile.size), 0)).where(StarFile.star_id == star_id))).scalar_one()
    )


@router.post("/{star_id}/channels/{channel_id}/files", response_model=StarFileOut, status_code=201)
async def upload_file(
    star_id: str,
    channel_id: str,
    request: Request,
    current_user: CurrentUser,
    db: Db,
    name: str = Query(..., min_length=1, max_length=1024),
):
    """Тело — сам файл, Content-Type — его тип. Потом файл уходит в сообщении (file_id)."""
    star, me = await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    assert_can_post(star, me)

    declared = request.headers.get("content-length")
    declared_size = int(declared) if declared and declared.isdigit() else 0
    if declared_size > star_files.MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail=TOO_LARGE)
    used = await _used(db, star_id)
    # Владельцу ресурса — без лимита места Звезды (лимит одного файла остаётся).
    unlimited = current_user.is_superuser or bool(
        (await db.execute(select(User.is_superuser).where(User.id == star.owner_id))).scalar_one_or_none()
    )
    if not unlimited and used + declared_size > _quota():
        raise HTTPException(
            status_code=507,
            detail=f"В Звезде закончилось место под файлы ({settings.STAR_FILES_QUOTA_MB // 1024} ГБ) — удалите старые",
        )
    try:
        star_files.ensure_free_space()
    except star_files.StorageFull:
        raise HTTPException(status_code=507, detail="На сервере закончилось место") from None

    file_id = str(uuid.uuid4())
    try:
        size = await star_files.save_stream(
            file_id, request.stream(), limit=star_files.MAX_FILE_BYTES if unlimited else min(star_files.MAX_FILE_BYTES, _quota() - used)
        )
    except star_files.FileTooLarge:
        raise HTTPException(status_code=413, detail=TOO_LARGE) from None
    if size == 0:
        star_files.delete_file(file_id)
        raise HTTPException(status_code=422, detail="Пустой файл")

    file = StarFile(
        id=file_id,
        star_id=star_id,
        channel_id=channel_id,
        uploader_id=current_user.id,
        name=star_files.clean_name(unquote(name)),
        mime=star_files.clean_mime(request.headers.get("content-type")),
        size=size,
    )
    db.add(file)
    await db.commit()
    return StarFileOut(id=file.id, name=file.name, mime=file.mime, size=file.size)


class StarFilesOut(BaseModel):
    files: list[StarFileListItem]
    used_bytes: int
    quota_bytes: int


@router.get("/{star_id}/files", response_model=StarFilesOut)
async def list_files(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    q: str = Query("", max_length=100),
    channel_id: str | None = None,
    kind: Literal["all", "images", "docs"] = "all",
    before: datetime | None = None,
    limit: int = Query(50, ge=1, le=100),
):
    """Отправленные файлы Звезды, свежие первыми. q — часть названия."""
    await _load_membership(db, star_id, current_user.id)
    query = (
        select(StarFile, User)
        .outerjoin(User, User.id == StarFile.uploader_id)
        .where(StarFile.star_id == star_id, StarFile.message_id.is_not(None))
    )
    words = q.split()
    for word in words:
        escaped = word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.where(StarFile.name.ilike(f"%{escaped}%", escape="\\"))
    if channel_id:
        query = query.where(StarFile.channel_id == channel_id)
    if kind == "images":
        query = query.where(StarFile.mime.like("image/%"))
    elif kind == "docs":
        query = query.where(StarFile.mime.not_like("image/%"))
    if before:
        query = query.where(StarFile.created_at < before)
    rows = (await db.execute(query.order_by(StarFile.created_at.desc()).limit(limit))).all()
    return StarFilesOut(
        files=[
            StarFileListItem(
                id=f.id,
                name=f.name,
                mime=f.mime,
                size=f.size,
                channel_id=f.channel_id,
                message_id=f.message_id,
                uploader=_user_out(u) if u else None,
                created_at=f.created_at,
            )
            for f, u in rows
        ],
        used_bytes=await _used(db, star_id),
        quota_bytes=_quota(),
    )


@router.get("/{star_id}/files/{file_id}")
async def download_file(star_id: str, file_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    file = (
        await db.execute(select(StarFile).where(StarFile.id == file_id, StarFile.star_id == star_id))
    ).scalar_one_or_none()
    # Не отправленный файл виден только тому, кто его загрузил.
    if not file or (file.message_id is None and file.uploader_id != current_user.id):
        raise HTTPException(status_code=404, detail="Файл не найден")
    path = star_files.file_path(file.id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    preview = file.mime in star_files.PREVIEW_MIMES
    return FileResponse(
        path,
        # Чужой HTML или SVG с нашего адреса не должен открыться как страница.
        media_type=file.mime if preview else "application/octet-stream",
        filename=file.name,
        content_disposition_type="inline" if preview else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400"},
    )

"""Файлы Спутников: загрузка (сырое тело запроса), раздел «Файлы» Звезды с поиском, скачивание."""

import hashlib
import hmac
import time
import uuid
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _chat, _load_membership, _load_viewer, _user_out, assert_can_post
from app.core import room_chat
from app.core import star_files, pseudonyms
from app.core.config import settings
from app.core import shares
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.star import StarChannel, StarFile
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
    star, me, channel = await _chat(db, star_id, channel_id, current_user.id)
    assert_can_post(star, me)
    # Файлы общего Спутника хранятся у Звезды-хозяина и занимают её место.
    owner_star_id = channel.star_id

    declared = request.headers.get("content-length")
    declared_size = int(declared) if declared and declared.isdigit() else 0
    if declared_size > star_files.MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail=TOO_LARGE)
    used = await _used(db, owner_star_id)
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
        star_id=owner_star_id,
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
    star, me = await _load_membership(db, star_id, current_user.id)
    query = (
        select(StarFile, User)
        .outerjoin(User, User.id == StarFile.uploader_id)
        .where(
            or_(StarFile.star_id == star_id, StarFile.channel_id.in_(await shares.shared_channel_ids(db, star_id))),
            StarFile.message_id.is_not(None),
        )
    )
    # Файлы из чатов комнат, куда человек не может войти, не показываем.
    hidden = await room_chat.hidden_rooms(db, star, me)
    if hidden:
        query = query.where(StarFile.channel_id.not_in(hidden))
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
    return await pseudonyms.in_star(db, star_id, StarFilesOut(
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
    ))


async def _room_ids(db: AsyncSession, star_id: str) -> set[str]:
    rows = await db.execute(select(StarChannel.id).where(StarChannel.star_id == star_id, StarChannel.kind == "planet"))
    return set(rows.scalars())


# Ссылка на файл для плеера и скачивания прямо на диск: <video> не умеет слать заголовок входа.
LINK_TTL_SEC = 3600


def _link_sig(file_id: str, expires: int) -> str:
    key = hashlib.sha256(f"quazar-star-file-link:{settings.JWT_SECRET}".encode()).digest()
    return hmac.new(key, f"{file_id}:{expires}".encode(), hashlib.sha256).hexdigest()


class StarFileLinkOut(BaseModel):
    url: str
    expires_at: int


async def _readable_file(db: AsyncSession, star_id: str, file_id: str, user_id: str) -> StarFile:
    """Файл, который этот человек может скачать (те же правила, что у самого скачивания)."""
    # Посетитель по гостевой ссылке скачивает файлы из чата своей Комнаты.
    star, me = await _load_viewer(db, star_id, user_id)
    file = (
        await db.execute(select(StarFile).where(StarFile.id == file_id))
    ).scalar_one_or_none()
    # Файл своей Звезды или общего Спутника, подключённого к ней.
    if file and file.star_id != star_id and not await shares.is_shared_into(db, file.channel_id, star_id):
        file = None
    if file and file.channel_id in await room_chat.hidden_rooms(db, star, me):
        file = None
    # Посетителю Спутники не видны.
    if file and me.role == "visitor" and file.channel_id not in await _room_ids(db, star_id):
        file = None
    # Не отправленный файл виден только тому, кто его загрузил.
    if not file or (file.message_id is None and file.uploader_id != user_id):
        raise HTTPException(status_code=404, detail="Файл не найден")
    return file


@router.get("/{star_id}/files/{file_id}/link", response_model=StarFileLinkOut)
async def file_link(star_id: str, file_id: str, current_user: CurrentUser, db: Db):
    """Ссылка на час: по ней файл открывается без входа (для <video> с перемоткой и скачивания)."""
    await _readable_file(db, star_id, file_id, current_user.id)
    expires = int(time.time()) + LINK_TTL_SEC
    return StarFileLinkOut(url=f"/stars/{star_id}/files/{file_id}/raw?e={expires}&s={_link_sig(file_id, expires)}",
                           expires_at=expires)


@router.get("/{star_id}/files/{file_id}/raw")
async def download_by_link(star_id: str, file_id: str, db: Db, e: int = Query(...), s: str = Query(..., max_length=128)):
    if e < time.time() or not hmac.compare_digest(s, _link_sig(file_id, e)):
        raise HTTPException(status_code=403, detail="Ссылка устарела — откройте файл заново")
    file = await db.get(StarFile, file_id)
    if not file or file.star_id != star_id and not await shares.is_shared_into(db, file.channel_id, star_id):
        raise HTTPException(status_code=404, detail="Файл не найден")
    return _file_response(file)


@router.get("/{star_id}/files/{file_id}")
async def download_file(star_id: str, file_id: str, current_user: CurrentUser, db: Db):
    return _file_response(await _readable_file(db, star_id, file_id, current_user.id))


def _file_response(file: StarFile) -> FileResponse:
    path = star_files.file_path(file.id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    preview = file.mime in star_files.PREVIEW_MIMES
    media = file.mime in star_files.MEDIA_MIMES
    return FileResponse(
        path,
        # Чужой HTML или SVG с нашего адреса не должен открыться как страница.
        media_type=file.mime if preview or media else "application/octet-stream",
        filename=file.name,
        content_disposition_type="inline" if preview or media else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400"},
    )

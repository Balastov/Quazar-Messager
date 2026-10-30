"""Закладки Спутника: полезные ссылки и документы в полосе под шапкой, до BOOKMARK_LIMIT.

Добавляет тот, кто может писать в Спутник (в канал объявлений — модераторы и выше).
Меняет и удаляет автор закладки или модераторы и выше. Файл — только уже отправленный в эту
Звезду (из раздела «Файлы»): закладка на него пропадает, когда файл удалят.
"""

import re
from datetime import datetime
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _broadcast, _forbid, _load_membership, _satellite, assert_can_post
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.star import StarBookmark, StarFile
from app.models.user import User
from app.schemas.star import StarFileOut

router = APIRouter(prefix="/stars", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

BOOKMARK_LIMIT = 30


class BookmarkBody(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    url: str | None = Field(default=None, max_length=2000)
    file_id: str | None = None
    emoji: str | None = Field(default=None, max_length=16)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Пустое название")
        return v

    @field_validator("url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        if not v:
            return None
        # «mailto:», «javascript:» и т. п. — не сайт; «host:8080» — сайт с портом.
        scheme = re.match(r"([a-zA-Z][a-zA-Z0-9+.-]*):(?!\d)", v)
        if scheme and scheme.group(1).lower() not in ("http", "https"):
            raise ValueError("Ссылка — адрес сайта, например https://example.com")
        if "://" not in v:
            v = f"https://{v}"
        parts = urlsplit(v)
        if parts.scheme not in ("http", "https") or not parts.netloc or " " in v:
            raise ValueError("Ссылка — адрес сайта, например https://example.com")
        return v

    @field_validator("emoji")
    @classmethod
    def _emoji(cls, v: str | None) -> str | None:
        return (v or "").strip() or None

    @model_validator(mode="after")
    def _one_target(self) -> "BookmarkBody":
        if bool(self.url) == bool(self.file_id):
            raise ValueError("Нужна ссылка или файл")
        return self


class BookmarkOut(BaseModel):
    id: str
    channel_id: str
    title: str
    url: str | None
    file: StarFileOut | None
    emoji: str | None
    created_by: str | None
    created_at: datetime


async def _list(db: AsyncSession, channel_id: str) -> list[BookmarkOut]:
    rows = (
        await db.execute(
            select(StarBookmark, StarFile)
            .outerjoin(StarFile, StarFile.id == StarBookmark.file_id)
            .where(StarBookmark.channel_id == channel_id)
            .order_by(StarBookmark.position, StarBookmark.created_at)
        )
    ).all()
    return [
        BookmarkOut(
            id=b.id,
            channel_id=b.channel_id,
            title=b.title,
            url=b.url,
            file=StarFileOut(id=f.id, name=f.name, mime=f.mime, size=f.size) if f else None,
            emoji=b.emoji,
            created_by=b.created_by,
            created_at=b.created_at,
        )
        for b, f in rows
    ]


async def _event(db: AsyncSession, star_id: str, channel_id: str) -> None:
    items = await _list(db, channel_id)
    await _broadcast(
        db,
        star_id,
        {"type": "star_bookmarks", "channel_id": channel_id, "bookmarks": [i.model_dump(mode="json") for i in items]},
    )


async def _check_file(db: AsyncSession, star_id: str, file_id: str | None) -> None:
    if not file_id:
        return
    file = (
        await db.execute(
            select(StarFile.id).where(
                StarFile.id == file_id, StarFile.star_id == star_id, StarFile.message_id.is_not(None)
            )
        )
    ).first()
    if not file:
        raise HTTPException(status_code=422, detail="Файл не найден в этой Звезде")


async def _editable(db: AsyncSession, star_id: str, channel_id: str, bookmark_id: str, user: User) -> StarBookmark:
    _, me = await _load_membership(db, star_id, user.id)
    bookmark = (
        await db.execute(
            select(StarBookmark).where(
                StarBookmark.id == bookmark_id, StarBookmark.channel_id == channel_id, StarBookmark.star_id == star_id
            )
        )
    ).scalar_one_or_none()
    if not bookmark:
        raise HTTPException(status_code=404, detail="Закладка не найдена")
    if bookmark.created_by != user.id and not rules.is_staff(me.role):
        raise _forbid("Менять закладку может её автор или модераторы")
    return bookmark


@router.get("/{star_id}/channels/{channel_id}/bookmarks", response_model=list[BookmarkOut])
async def list_bookmarks(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    return await _list(db, channel_id)


@router.post(
    "/{star_id}/channels/{channel_id}/bookmarks", response_model=BookmarkOut, status_code=status.HTTP_201_CREATED
)
async def add_bookmark(star_id: str, channel_id: str, body: BookmarkBody, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _satellite(db, star_id, channel_id)
    assert_can_post(star, me)
    if channel.announcement and not rules.is_staff(me.role):
        raise _forbid("В канале объявлений закладки добавляют модераторы и выше")
    await _check_file(db, star_id, body.file_id)
    count, top = (
        await db.execute(
            select(func.count(), func.max(StarBookmark.position)).where(StarBookmark.channel_id == channel_id)
        )
    ).one()
    if count >= BOOKMARK_LIMIT:
        raise HTTPException(status_code=409, detail=f"Не больше {BOOKMARK_LIMIT} закладок в Спутнике")
    bookmark = StarBookmark(
        star_id=star_id,
        channel_id=channel_id,
        position=(top or 0) + 1,
        created_by=current_user.id,
        **body.model_dump(),
    )
    db.add(bookmark)
    await db.commit()
    await _event(db, star_id, channel_id)
    return next(b for b in await _list(db, channel_id) if b.id == bookmark.id)


@router.patch("/{star_id}/channels/{channel_id}/bookmarks/{bookmark_id}", response_model=BookmarkOut)
async def update_bookmark(
    star_id: str, channel_id: str, bookmark_id: str, body: BookmarkBody, current_user: CurrentUser, db: Db
):
    bookmark = await _editable(db, star_id, channel_id, bookmark_id, current_user)
    await _check_file(db, star_id, body.file_id)
    for key, value in body.model_dump().items():
        setattr(bookmark, key, value)
    await db.commit()
    await _event(db, star_id, channel_id)
    return next(b for b in await _list(db, channel_id) if b.id == bookmark_id)


@router.delete("/{star_id}/channels/{channel_id}/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bookmark(star_id: str, channel_id: str, bookmark_id: str, current_user: CurrentUser, db: Db):
    bookmark = await _editable(db, star_id, channel_id, bookmark_id, current_user)
    await db.delete(bookmark)
    await db.commit()
    await _event(db, star_id, channel_id)


class OrderBody(BaseModel):
    ids: list[str] = Field(max_length=BOOKMARK_LIMIT)


@router.put("/{star_id}/channels/{channel_id}/bookmarks", response_model=list[BookmarkOut])
async def reorder_bookmarks(star_id: str, channel_id: str, body: OrderBody, current_user: CurrentUser, db: Db):
    """Новый порядок полосы (перетаскивание) — модераторы и выше."""
    _, me = await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    if not rules.is_staff(me.role):
        raise _forbid("Порядок закладок меняют модераторы и выше")
    bookmarks = {
        b.id: b
        for b in (await db.execute(select(StarBookmark).where(StarBookmark.channel_id == channel_id))).scalars()
    }
    order = [i for i in body.ids if i in bookmarks] + [i for i in bookmarks if i not in body.ids]
    for pos, bookmark_id in enumerate(order, start=1):
        bookmarks[bookmark_id].position = pos
    await db.commit()
    await _event(db, star_id, channel_id)
    return await _list(db, channel_id)

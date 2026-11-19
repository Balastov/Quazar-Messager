"""Зелёный колокольчик: список уведомлений и отметка «прочитано»."""

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import inbox
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.inbox import InboxNotification
from app.models.user import User
from app.ws.hub import manager

router = APIRouter(prefix="/inbox", tags=["inbox"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


class InboxItemOut(BaseModel):
    id: str
    kind: str
    title: str
    body: str
    data: dict
    created_at: datetime
    read_at: datetime | None


class InboxOut(BaseModel):
    items: list[InboxItemOut]
    unread: int


class UnreadOut(BaseModel):
    unread: int


@router.get("", response_model=InboxOut)
async def list_inbox(
    current_user: CurrentUser,
    db: Db,
    before: datetime | None = None,
    limit: int = Query(30, ge=1, le=100),
):
    """Свежие первыми; before — для подгрузки более старых."""
    query = select(InboxNotification).where(InboxNotification.user_id == current_user.id)
    if before:
        query = query.where(InboxNotification.created_at < before)
    rows = (await db.execute(query.order_by(InboxNotification.created_at.desc()).limit(limit))).scalars().all()
    return InboxOut(
        items=[InboxItemOut(**inbox.out(r)) for r in rows],
        unread=await inbox.unread_count(db, current_user.id),
    )


async def _read(db: AsyncSession, user: User, ids: list[str] | None) -> int:
    query = (
        update(InboxNotification)
        .where(InboxNotification.user_id == user.id, InboxNotification.read_at.is_(None))
        .values(read_at=datetime.now(timezone.utc))
    )
    if ids is not None:
        query = query.where(InboxNotification.id.in_(ids))
    await db.execute(query)
    await db.commit()
    unread = await inbox.unread_count(db, user.id)
    # Остальные устройства тоже убирают отметку и уменьшают счётчик.
    await manager.send_to_user(user.id, {"type": "inbox_read", "ids": ids, "unread": unread})
    return unread


@router.post("/read-all", response_model=UnreadOut)
async def read_all(current_user: CurrentUser, db: Db):
    return UnreadOut(unread=await _read(db, current_user, None))


@router.post("/{notification_id}/read", response_model=UnreadOut)
async def read_one(notification_id: str, current_user: CurrentUser, db: Db):
    exists = (
        await db.execute(
            select(InboxNotification.id).where(
                InboxNotification.id == notification_id, InboxNotification.user_id == current_user.id
            )
        )
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    return UnreadOut(unread=await _read(db, current_user, [notification_id]))

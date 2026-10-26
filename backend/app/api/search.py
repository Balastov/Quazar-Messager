"""Поиск по сообщениям Спутников. Личные чаты сервер прочитать не может — их ищет клиент."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _load_membership, _messages_out
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.star import StarChannel, StarFile, StarMessage
from app.models.user import User
from app.schemas.star import StarMessageOut

router = APIRouter(prefix="/stars", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


def _like(word: str) -> str:
    escaped = word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@router.get("/{star_id}/search", response_model=list[StarMessageOut])
async def search_messages(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    q: str = Query(..., min_length=2, max_length=100),
    channel_id: str | None = None,
    before: datetime | None = None,
    limit: int = Query(30, ge=1, le=50),
):
    """Все слова запроса — в тексте сообщения или в названии его файла (без учёта регистра).
    Свежие первыми; ответы в ветках — тоже (у них есть thread_id)."""
    await _load_membership(db, star_id, current_user.id)
    query = (
        select(StarMessage, User)
        .outerjoin(User, User.id == StarMessage.sender_id)
        .join(StarChannel, StarChannel.id == StarMessage.channel_id)
        .where(StarMessage.star_id == star_id, StarChannel.kind == "satellite", StarMessage.kind != "system")
    )
    for word in q.split()[:8]:
        pattern = _like(word)
        has_file = exists().where(StarFile.message_id == StarMessage.id, StarFile.name.ilike(pattern, escape="\\"))
        query = query.where(or_(StarMessage.text.ilike(pattern, escape="\\"), has_file))
    if channel_id:
        query = query.where(StarMessage.channel_id == channel_id)
    if before:
        query = query.where(StarMessage.created_at < before)
    rows = await db.execute(query.order_by(StarMessage.created_at.desc()).limit(limit))
    return await _messages_out(db, list(rows.tuples()), current_user.id)

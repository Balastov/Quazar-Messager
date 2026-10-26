"""Блокировка пользователей и жалобы.

Заблокированный не узнаёт о блокировке: его сообщения сохраняются, но заблокировавшему
не приходят (у отправителя остаётся одна галочка); звонки не доходят — «не в сети».
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.chat import ChatMember
from app.models.moderation import UserBlock, UserReport
from app.models.user import User
from app.schemas.user import UserOut
from app.ws.hub import manager

log = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["moderation"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

# Больше этого жалоб за сутки от одного человека не принимаем.
REPORTS_PER_DAY = 20


class EvidenceItem(BaseModel):
    sender: Literal["me", "them"]
    at: datetime
    text: str = Field(max_length=4000)


class ReportBody(BaseModel):
    reason: Literal["spam", "abuse", "fraud", "other"]
    comment: str | None = Field(default=None, max_length=2000)
    chat_id: str | None = None
    # Последние сообщения, расшифрованные клиентом, — только если человек согласился приложить.
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=10)
    # Сразу и заблокировать.
    block: bool = False


async def _target(db: AsyncSession, user_id: str, me: User) -> User:
    if user_id == me.id:
        raise HTTPException(status_code=400, detail="Нельзя заблокировать или пожаловаться на себя")
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    return user


async def _set_block(db: AsyncSession, me: User, target: User, blocked: bool) -> None:
    if blocked:
        await db.execute(
            insert(UserBlock).values(blocker_id=me.id, blocked_id=target.id).on_conflict_do_nothing()
        )
    else:
        await db.execute(
            delete(UserBlock).where(UserBlock.blocker_id == me.id, UserBlock.blocked_id == target.id)
        )
    await db.commit()
    # Другие мои устройства тоже должны знать.
    await manager.send_to_user(me.id, {"type": "blocks_changed", "user_id": target.id, "blocked": blocked})


@router.get("/me/blocks", response_model=list[UserOut])
async def list_blocks(current_user: CurrentUser, db: Db):
    rows = await db.execute(
        select(User)
        .join(UserBlock, UserBlock.blocked_id == User.id)
        .where(UserBlock.blocker_id == current_user.id)
        .order_by(UserBlock.created_at.desc())
    )
    return list(rows.scalars().all())


@router.put("/{user_id}/block", status_code=status.HTTP_204_NO_CONTENT)
async def block_user(user_id: str, current_user: CurrentUser, db: Db):
    await _set_block(db, current_user, await _target(db, user_id, current_user), True)


@router.delete("/{user_id}/block", status_code=status.HTTP_204_NO_CONTENT)
async def unblock_user(user_id: str, current_user: CurrentUser, db: Db):
    await _set_block(db, current_user, await _target(db, user_id, current_user), False)


@router.post("/{user_id}/report", status_code=status.HTTP_201_CREATED)
async def report_user(user_id: str, body: ReportBody, current_user: CurrentUser, db: Db) -> dict:
    target = await _target(db, user_id, current_user)
    since = datetime.now(timezone.utc) - timedelta(days=1)
    recent = (
        await db.execute(
            select(func.count())
            .select_from(UserReport)
            .where(UserReport.reporter_id == current_user.id, UserReport.created_at > since)
        )
    ).scalar_one()
    if recent >= REPORTS_PER_DAY:
        raise HTTPException(status_code=429, detail="Слишком много жалоб — попробуйте завтра")

    chat_id = None
    if body.chat_id:
        # Чат должен быть общим с обоими, иначе не прикладываем.
        members = set(
            (
                await db.execute(select(ChatMember.user_id).where(ChatMember.chat_id == body.chat_id))
            ).scalars().all()
        )
        if {current_user.id, target.id} <= members:
            chat_id = body.chat_id

    report = UserReport(
        reporter_id=current_user.id,
        target_id=target.id,
        chat_id=chat_id,
        reason=body.reason,
        comment=body.comment,
        evidence=[e.model_dump(mode="json") for e in body.evidence],
    )
    db.add(report)
    await db.commit()
    log.warning(
        "user report %s: %s on %s (%s), evidence %d",
        report.id, current_user.id, target.id, body.reason, len(body.evidence),
    )
    if body.block:
        await _set_block(db, current_user, target, True)
    return {"id": report.id}

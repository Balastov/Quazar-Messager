"""Мои уровни уведомлений: чат, Звезда, Спутник. Хранятся на сервере — одинаковы на всех устройствах."""

from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.chat import ChatMember
from app.models.notify import NotifySetting
from app.models.star import StarChannel, StarMember
from app.models.user import User
from app.ws.hub import manager

router = APIRouter(prefix="/users", tags=["users"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

Scope = Literal["chat", "star", "channel"]
Level = Literal["all", "mentions", "none"]


class NotifyOut(BaseModel):
    scope: Scope
    target_id: str
    level: Level | None
    muted_until: datetime | None


class NotifyBody(BaseModel):
    # None — как уровнем выше (для чата и Звезды — по умолчанию).
    level: Level | None = None
    # Тишина до этого момента; None — без тишины.
    muted_until: datetime | None = None


def _out(s: NotifySetting) -> NotifyOut:
    return NotifyOut(scope=s.scope, target_id=s.target_id, level=s.level, muted_until=s.muted_until)  # type: ignore[arg-type]


async def _assert_target(db: AsyncSession, user_id: str, scope: str, target_id: str) -> None:
    if scope == "chat":
        query = select(ChatMember.user_id).where(ChatMember.chat_id == target_id, ChatMember.user_id == user_id)
    elif scope == "star":
        query = select(StarMember.user_id).where(StarMember.star_id == target_id, StarMember.user_id == user_id)
    else:
        query = (
            select(StarMember.user_id)
            .join(StarChannel, StarChannel.star_id == StarMember.star_id)
            .where(StarChannel.id == target_id, StarChannel.kind == "satellite", StarMember.user_id == user_id)
        )
    if (await db.execute(query)).first() is None:
        raise HTTPException(status_code=404, detail="Не найдено")


@router.get("/me/notify", response_model=list[NotifyOut])
async def my_notify_settings(current_user: CurrentUser, db: Db):
    rows = (await db.execute(select(NotifySetting).where(NotifySetting.user_id == current_user.id))).scalars()
    return [_out(s) for s in rows]


@router.put("/me/notify/{scope}/{target_id}", response_model=NotifyOut)
async def set_notify(scope: Scope, target_id: str, body: NotifyBody, current_user: CurrentUser, db: Db):
    await _assert_target(db, current_user.id, scope, target_id)
    now = datetime.now(timezone.utc)
    if body.muted_until and body.muted_until.tzinfo is None:
        raise HTTPException(status_code=422, detail="Время — с часовым поясом")
    muted = body.muted_until if body.muted_until and body.muted_until > now else None
    setting = await db.get(NotifySetting, (current_user.id, scope, target_id))
    if body.level is None and muted is None:
        if setting:
            await db.delete(setting)
    else:
        if not setting:
            setting = NotifySetting(user_id=current_user.id, scope=scope, target_id=target_id)
            db.add(setting)
        setting.level = body.level
        setting.muted_until = muted
        setting.updated_at = now
    await db.commit()
    out = NotifyOut(scope=scope, target_id=target_id, level=body.level, muted_until=muted)
    # Остальные мои устройства.
    await manager.send_to_user(current_user.id, {"type": "notify_setting", **out.model_dump(mode="json")})
    return out


@router.delete("/me/notify/{scope}/{target_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reset_notify(scope: Scope, target_id: str, current_user: CurrentUser, db: Db):
    await set_notify(scope, target_id, NotifyBody(), current_user, db)

"""Личная очередь отложенных сообщений Спутника. Доставляет серверный scheduler."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select

from app.api.later import MAX_PENDING_PER_USER, CurrentUser, Db, _check_time
from app.api.stars import _load_membership, _satellite, prepare_message
from app.core.stars import MAX_MESSAGE_LENGTH
from app.models.star import ScheduledStarMessage
from app.schemas.star import LinkPreview, SendStarMessage
from app.ws.hub import manager

router = APIRouter(prefix="/stars/{star_id}/channels/{channel_id}/scheduled", tags=["scheduled"])


class ScheduleStarBody(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_LENGTH)
    send_at: datetime
    reply_to_id: str | None = None
    ack_required: bool = False
    link_preview: LinkPreview | None = None

    @field_validator("text")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Сообщение не может быть пустым")
        return value

    def message(self) -> SendStarMessage:
        return SendStarMessage(**self.model_dump(exclude={"send_at"}))


class ScheduledStarOut(BaseModel):
    id: str
    star_id: str
    channel_id: str
    text: str
    reply_to_id: str | None
    ack_required: bool
    link_preview: LinkPreview | None
    send_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


async def scheduled_changed(user_id: str, star_id: str, channel_id: str, error: str | None = None) -> None:
    event = {"type": "star_scheduled_changed", "star_id": star_id, "channel_id": channel_id}
    if error:
        event["error"] = error
    await manager.send_to_user(user_id, event)


@router.get("", response_model=list[ScheduledStarOut])
async def list_scheduled(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    rows = await db.execute(
        select(ScheduledStarMessage)
        .where(
            ScheduledStarMessage.star_id == star_id,
            ScheduledStarMessage.channel_id == channel_id,
            ScheduledStarMessage.sender_id == current_user.id,
        )
        .order_by(ScheduledStarMessage.send_at, ScheduledStarMessage.created_at)
    )
    return list(rows.scalars().all())


@router.post("", response_model=ScheduledStarOut, status_code=status.HTTP_201_CREATED)
async def schedule_message(
    star_id: str, channel_id: str, body: ScheduleStarBody, current_user: CurrentUser, db: Db
):
    send_at = _check_time(body.send_at)
    await prepare_message(db, star_id, channel_id, body.message(), current_user, check_slow_mode=False)
    pending = (
        await db.execute(
            select(func.count()).select_from(ScheduledStarMessage)
            .where(ScheduledStarMessage.sender_id == current_user.id)
        )
    ).scalar_one()
    if pending >= MAX_PENDING_PER_USER:
        raise HTTPException(status_code=429, detail="Слишком много отложенных сообщений")
    item = ScheduledStarMessage(
        star_id=star_id,
        channel_id=channel_id,
        sender_id=current_user.id,
        **body.model_dump(exclude={"send_at"}),
        send_at=send_at,
    )
    db.add(item)
    await db.commit()
    await scheduled_changed(current_user.id, star_id, channel_id)
    return item


@router.delete("/{scheduled_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_scheduled(
    star_id: str, channel_id: str, scheduled_id: str, current_user: CurrentUser, db: Db
):
    result = await db.execute(
        delete(ScheduledStarMessage).where(
            ScheduledStarMessage.id == scheduled_id,
            ScheduledStarMessage.star_id == star_id,
            ScheduledStarMessage.channel_id == channel_id,
            ScheduledStarMessage.sender_id == current_user.id,
        )
    )
    await db.commit()
    if not result.rowcount:
        raise HTTPException(status_code=404, detail="Уже отправлено или отменено")
    await scheduled_changed(current_user.id, star_id, channel_id)

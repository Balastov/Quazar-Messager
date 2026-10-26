"""Отложенная отправка и напоминания о сообщениях. Срабатывают в app.core.scheduler.

Отложенное сообщение шифруется клиентом сразу, при планировании: сервер его не читает и
в назначенное время просто превращает в обычное сообщение.
"""

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.blocks import block_state, direct_peer
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.chat import ChatMember
from app.models.message import Message, MessageReminder, ScheduledMessage
from app.models.user import User
from app.schemas.message import MAX_PAYLOAD_LENGTH
from app.ws.hub import manager

scheduled_router = APIRouter(prefix="/chats/{chat_id}/scheduled", tags=["scheduled"])
reminders_router = APIRouter(prefix="/reminders", tags=["reminders"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

# Не раньше чем через столько — иначе это обычная отправка.
MIN_DELAY = timedelta(seconds=30)
MAX_DELAY = timedelta(days=365)
MAX_PENDING_PER_USER = 100


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _check_time(at: datetime) -> datetime:
    if at.tzinfo is None:
        raise HTTPException(status_code=422, detail="Время нужно с часовым поясом")
    now = _now()
    if at < now + MIN_DELAY:
        raise HTTPException(status_code=422, detail="Время уже прошло или слишком близко")
    if at > now + MAX_DELAY:
        raise HTTPException(status_code=422, detail="Не дальше чем через год")
    return at


async def _assert_member(db: AsyncSession, chat_id: str, user_id: str) -> None:
    member = (
        await db.execute(
            select(ChatMember).where(ChatMember.chat_id == chat_id, ChatMember.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=403, detail="Access denied")


# --- Отложенные сообщения ------------------------------------------------------


class ScheduleBody(BaseModel):
    payload: str = Field(min_length=1, max_length=MAX_PAYLOAD_LENGTH)
    send_at: datetime
    reply_to_id: str | None = None


class ScheduledOut(BaseModel):
    id: str
    chat_id: str
    payload: str
    reply_to_id: str | None
    send_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


async def scheduled_changed(user_id: str, chat_id: str) -> None:
    """Список отложенных изменился — пусть все мои устройства перечитают."""
    await manager.send_to_user(user_id, {"type": "scheduled_changed", "chat_id": chat_id})


@scheduled_router.get("", response_model=list[ScheduledOut])
async def list_scheduled(chat_id: str, current_user: CurrentUser, db: Db):
    await _assert_member(db, chat_id, current_user.id)
    rows = await db.execute(
        select(ScheduledMessage)
        .where(ScheduledMessage.chat_id == chat_id, ScheduledMessage.sender_id == current_user.id)
        .order_by(ScheduledMessage.send_at)
    )
    return list(rows.scalars().all())


@scheduled_router.post("", response_model=ScheduledOut, status_code=status.HTTP_201_CREATED)
async def schedule_message(chat_id: str, body: ScheduleBody, current_user: CurrentUser, db: Db):
    await _assert_member(db, chat_id, current_user.id)
    send_at = _check_time(body.send_at)
    peer = await direct_peer(db, chat_id, current_user.id)
    if peer and (await block_state(db, current_user.id, peer))[0]:
        raise HTTPException(
            status_code=403, detail="Вы заблокировали пользователя — разблокируйте, чтобы писать"
        )
    pending = (
        await db.execute(
            select(func.count())
            .select_from(ScheduledMessage)
            .where(ScheduledMessage.sender_id == current_user.id)
        )
    ).scalar_one()
    if pending >= MAX_PENDING_PER_USER:
        raise HTTPException(status_code=429, detail="Слишком много отложенных сообщений")
    if body.reply_to_id:
        reply = (
            await db.execute(
                select(Message.id).where(Message.id == body.reply_to_id, Message.chat_id == chat_id)
            )
        ).scalar_one_or_none()
        if not reply:
            raise HTTPException(status_code=422, detail="Сообщение для ответа не найдено")

    item = ScheduledMessage(
        chat_id=chat_id,
        sender_id=current_user.id,
        payload=body.payload,
        reply_to_id=body.reply_to_id,
        send_at=send_at,
    )
    db.add(item)
    await db.commit()
    await scheduled_changed(current_user.id, chat_id)
    return item


@scheduled_router.delete("/{scheduled_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_scheduled(chat_id: str, scheduled_id: str, current_user: CurrentUser, db: Db):
    result = await db.execute(
        delete(ScheduledMessage).where(
            ScheduledMessage.id == scheduled_id,
            ScheduledMessage.chat_id == chat_id,
            ScheduledMessage.sender_id == current_user.id,
        )
    )
    await db.commit()
    if not result.rowcount:
        raise HTTPException(status_code=404, detail="Уже отправлено или отменено")
    await scheduled_changed(current_user.id, chat_id)


# --- Напоминания ---------------------------------------------------------------


class ReminderBody(BaseModel):
    chat_id: str
    message_id: str
    remind_at: datetime


class ReminderOut(BaseModel):
    id: str
    chat_id: str
    message_id: str
    remind_at: datetime

    model_config = {"from_attributes": True}


@reminders_router.get("", response_model=list[ReminderOut])
async def list_reminders(current_user: CurrentUser, db: Db):
    rows = await db.execute(
        select(MessageReminder)
        .where(MessageReminder.user_id == current_user.id)
        .order_by(MessageReminder.remind_at)
    )
    return list(rows.scalars().all())


@reminders_router.post("", response_model=ReminderOut, status_code=status.HTTP_201_CREATED)
async def set_reminder(body: ReminderBody, current_user: CurrentUser, db: Db):
    """Напомнить о сообщении; повторно на то же сообщение — переставить время."""
    await _assert_member(db, body.chat_id, current_user.id)
    remind_at = _check_time(body.remind_at)
    message = (
        await db.execute(
            select(Message.id).where(Message.id == body.message_id, Message.chat_id == body.chat_id)
        )
    ).scalar_one_or_none()
    if not message:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    row = (
        await db.execute(
            insert(MessageReminder)
            .values(
                user_id=current_user.id,
                chat_id=body.chat_id,
                message_id=body.message_id,
                remind_at=remind_at,
            )
            .on_conflict_do_update(
                index_elements=[MessageReminder.user_id, MessageReminder.message_id],
                set_={"remind_at": remind_at},
            )
            .returning(MessageReminder)
        )
    ).scalar_one()
    await db.commit()
    return row


@reminders_router.delete("/{reminder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_reminder(reminder_id: str, current_user: CurrentUser, db: Db):
    result = await db.execute(
        delete(MessageReminder).where(
            MessageReminder.id == reminder_id, MessageReminder.user_id == current_user.id
        )
    )
    await db.commit()
    if not result.rowcount:
        raise HTTPException(status_code=404, detail="Напоминание не найдено")

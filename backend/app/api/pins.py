"""Закреплённые сообщения: в чатах и Спутниках, до PIN_LIMIT на чат или Спутник.

Кто закрепляет: в личном чате и «Избранном» — оба участника, в группе — владелец и админы,
в Спутнике — те, кто может удалять чужие сообщения (модераторы и выше).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.messages import _assert_member, _chat_message, _get_chat_member_ids, messages_out, visible_to
from app.api.stars import _as_star, _broadcast, _forbid, _load_membership, _messages_out, _satellite, _star_message
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.chat import Chat
from app.models.message import Message
from app.models.pin import ChatPin, StarPin
from app.models.star import StarMessage
from app.models.user import User
from app.schemas.message import MessageOut
from app.schemas.star import StarMessageOut
from app.ws.hub import manager

router = APIRouter(tags=["pins"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

PIN_LIMIT = 50


# --- Чаты ------------------------------------------------------------------------


async def _chat_pin_ids(db: AsyncSession, chat_id: str) -> list[str]:
    rows = await db.execute(
        select(ChatPin.message_id).where(ChatPin.chat_id == chat_id).order_by(ChatPin.created_at.desc())
    )
    return list(rows.scalars())


async def _assert_can_pin_chat(db: AsyncSession, chat_id: str, user: User) -> None:
    member = await _assert_member(chat_id, user.id, db)
    chat_type = (await db.execute(select(Chat.type).where(Chat.id == chat_id))).scalar_one()
    if chat_type == "group" and member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="В группе закрепляют владелец и админы")


async def _chat_pins_event(db: AsyncSession, chat_id: str) -> None:
    await manager.broadcast_to_users(
        await _get_chat_member_ids(chat_id, db),
        {"type": "chat_pins", "chat_id": chat_id, "message_ids": await _chat_pin_ids(db, chat_id)},
    )


@router.get("/chats/{chat_id}/pins", response_model=list[MessageOut])
async def list_chat_pins(chat_id: str, current_user: CurrentUser, db: Db):
    """Закреплённые — свежие первыми. Удалённые «у меня» и исчезнувшие не показываем."""
    await _assert_member(chat_id, current_user.id, db)
    rows = await db.execute(
        select(Message)
        .join(ChatPin, ChatPin.message_id == Message.id)
        .where(ChatPin.chat_id == chat_id, visible_to(current_user.id))
        .order_by(ChatPin.created_at.desc())
    )
    return await messages_out(db, list(rows.scalars()))


@router.put("/chats/{chat_id}/pins/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def pin_chat_message(chat_id: str, message_id: str, current_user: CurrentUser, db: Db):
    await _assert_can_pin_chat(db, chat_id, current_user)
    await _chat_message(chat_id, message_id, db)
    count = (await db.execute(select(func.count()).select_from(ChatPin).where(ChatPin.chat_id == chat_id))).scalar_one()
    if count >= PIN_LIMIT:
        raise HTTPException(status_code=409, detail=f"Закрепить можно не больше {PIN_LIMIT} сообщений")
    await db.execute(
        insert(ChatPin)
        .values(chat_id=chat_id, message_id=message_id, pinned_by=current_user.id)
        .on_conflict_do_nothing()
    )
    await db.commit()
    await _chat_pins_event(db, chat_id)


@router.delete("/chats/{chat_id}/pins/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unpin_chat_message(chat_id: str, message_id: str, current_user: CurrentUser, db: Db):
    await _assert_can_pin_chat(db, chat_id, current_user)
    await db.execute(delete(ChatPin).where(ChatPin.chat_id == chat_id, ChatPin.message_id == message_id))
    await db.commit()
    await _chat_pins_event(db, chat_id)


# --- Спутники --------------------------------------------------------------------


async def _star_pin_ids(db: AsyncSession, channel_id: str) -> list[str]:
    rows = await db.execute(
        select(StarPin.message_id).where(StarPin.channel_id == channel_id).order_by(StarPin.created_at.desc())
    )
    return list(rows.scalars())


async def _star_pins_event(db: AsyncSession, star_id: str, channel_id: str) -> None:
    await _broadcast(
        db,
        star_id,
        {"type": "star_pins", "channel_id": channel_id, "message_ids": await _star_pin_ids(db, channel_id)},
    )


async def _assert_can_pin_star(db: AsyncSession, star_id: str, user: User, channel_id: str) -> None:
    star, me = await _load_membership(db, star_id, user.id)
    channel = await _satellite(db, star_id, channel_id)
    if not rules.has_perm(me.role, Perm.DELETE_MESSAGES, star.role_permissions):
        raise _forbid("Закрепляют модераторы и выше")
    if channel.star_id != star_id:
        raise _forbid("В общем Спутнике закрепляют модераторы Звезды, которой он принадлежит")


@router.get("/stars/{star_id}/channels/{channel_id}/pins", response_model=list[StarMessageOut])
async def list_star_pins(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    rows = await db.execute(
        select(StarMessage, User)
        .join(StarPin, StarPin.message_id == StarMessage.id)
        .outerjoin(User, User.id == StarMessage.sender_id)
        .where(StarPin.channel_id == channel_id)
        .order_by(StarPin.created_at.desc())
    )
    return _as_star(await _messages_out(db, list(rows.tuples()), current_user.id), star_id)


@router.put("/stars/{star_id}/channels/{channel_id}/pins/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def pin_star_message(star_id: str, channel_id: str, message_id: str, current_user: CurrentUser, db: Db):
    await _assert_can_pin_star(db, star_id, current_user, channel_id)
    message = await _star_message(db, star_id, channel_id, message_id)
    if message.thread_id:
        raise HTTPException(status_code=422, detail="Ответ в ветке закрепить нельзя")
    count = (await db.execute(select(func.count()).select_from(StarPin).where(StarPin.channel_id == channel_id))).scalar_one()
    if count >= PIN_LIMIT:
        raise HTTPException(status_code=409, detail=f"Закрепить можно не больше {PIN_LIMIT} сообщений")
    await db.execute(
        insert(StarPin)
        .values(channel_id=channel_id, message_id=message_id, star_id=star_id, pinned_by=current_user.id)
        .on_conflict_do_nothing()
    )
    await db.commit()
    await _star_pins_event(db, star_id, channel_id)


@router.delete("/stars/{star_id}/channels/{channel_id}/pins/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unpin_star_message(star_id: str, channel_id: str, message_id: str, current_user: CurrentUser, db: Db):
    await _assert_can_pin_star(db, star_id, current_user, channel_id)
    await db.execute(delete(StarPin).where(StarPin.channel_id == channel_id, StarPin.message_id == message_id))
    await db.commit()
    await _star_pins_event(db, star_id, channel_id)

from collections import defaultdict
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import attachments as attachment_files
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.reactions import REACTIONS
from app.models.attachment import Attachment
from app.models.chat import Chat, ChatMember
from app.models.message import HiddenMessage, Message, MessageReaction
from app.models.user import User
from app.schemas.message import (
    EditMessage,
    MessageOut,
    ReactionOut,
    ReplyOut,
    SendMessage,
    SetReaction,
)
from app.ws.hub import manager

router = APIRouter(prefix="/chats/{chat_id}/messages", tags=["messages"])


async def _get_chat_member_ids(chat_id: str, db: AsyncSession) -> list[str]:
    result = await db.execute(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)
    )
    return [row[0] for row in result.all()]


async def _assert_member(chat_id: str, user_id: str, db: AsyncSession) -> ChatMember:
    result = await db.execute(
        select(ChatMember).where(
            ChatMember.chat_id == chat_id,
            ChatMember.user_id == user_id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=403, detail="Access denied")
    return member


async def _chat_message(chat_id: str, message_id: str, db: AsyncSession) -> Message:
    message = (
        await db.execute(
            select(Message).where(Message.id == message_id, Message.chat_id == chat_id)
        )
    ).scalar_one_or_none()
    if not message:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    return message


def _reply_out(message: Message | None) -> ReplyOut | None:
    if message is None:
        return None
    return ReplyOut(id=message.id, sender_id=message.sender_id, payload=message.payload)


async def messages_out(db: AsyncSession, messages: list[Message]) -> list[MessageOut]:
    """Сообщения вместе с цитатами ответов и реакциями — двумя запросами на всю страницу."""
    reply_ids = {m.reply_to_id for m in messages if m.reply_to_id}
    replies: dict[str, Message] = {}
    if reply_ids:
        rows = await db.execute(select(Message).where(Message.id.in_(reply_ids)))
        replies = {m.id: m for m in rows.scalars()}

    reactions: dict[str, list[ReactionOut]] = defaultdict(list)
    if messages:
        rows = await db.execute(
            select(MessageReaction)
            .where(MessageReaction.message_id.in_([m.id for m in messages]))
            .order_by(MessageReaction.created_at)
        )
        for r in rows.scalars():
            reactions[r.message_id].append(ReactionOut(user_id=r.user_id, payload=r.payload))

    return [
        MessageOut(
            id=m.id,
            chat_id=m.chat_id,
            sender_id=m.sender_id,
            payload=m.payload,
            status=m.status,
            created_at=m.created_at,
            edited_at=m.edited_at,
            reply_to=_reply_out(replies.get(m.reply_to_id)) if m.reply_to_id else None,
            reactions=reactions[m.id],
        )
        for m in messages
    ]


def new_message_event(message: Message, reply_to: Message | None = None) -> dict:
    return {
        "type": "new_message",
        "message_id": message.id,
        "chat_id": message.chat_id,
        "sender_id": message.sender_id,
        "payload": message.payload,
        "status": message.status,
        "timestamp": message.created_at.isoformat(),
        "reply_to": r.model_dump() if (r := _reply_out(reply_to)) else None,
    }


@router.get("", response_model=list[MessageOut])
async def get_messages(
    chat_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(50, le=100),
    before_id: str | None = Query(None),
):
    await _assert_member(chat_id, current_user.id, db)

    hidden = select(HiddenMessage.message_id).where(HiddenMessage.user_id == current_user.id)
    query = select(Message).where(Message.chat_id == chat_id, Message.id.not_in(hidden))
    if before_id:
        # курсорная пагинация по id (uuid не сортируется по времени, используем created_at)
        result = await db.execute(select(Message.created_at).where(Message.id == before_id))
        cursor_ts = result.scalar_one_or_none()
        if cursor_ts:
            query = query.where(Message.created_at < cursor_ts)

    query = query.order_by(Message.created_at.desc()).limit(limit)
    result = await db.execute(query)
    messages = list(reversed(result.scalars().all()))
    return await messages_out(db, messages)


@router.post("", response_model=MessageOut, status_code=201)
async def send_message(
    chat_id: str,
    body: SendMessage,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _assert_member(chat_id, current_user.id, db)

    reply_to = None
    if body.reply_to_id:
        reply_to = (
            await db.execute(
                select(Message).where(
                    Message.id == body.reply_to_id, Message.chat_id == chat_id
                )
            )
        ).scalar_one_or_none()
        if not reply_to:
            raise HTTPException(status_code=422, detail="Сообщение для ответа не найдено")

    message = Message(
        chat_id=chat_id,
        sender_id=current_user.id,
        payload=body.payload,
        reply_to_id=reply_to.id if reply_to else None,
    )
    db.add(message)
    if body.attachment_id:
        attachment = (
            await db.execute(
                select(Attachment).where(
                    Attachment.id == body.attachment_id,
                    Attachment.chat_id == chat_id,
                    Attachment.uploader_id == current_user.id,
                    Attachment.message_id.is_(None),
                )
            )
        ).scalar_one_or_none()
        if not attachment:
            raise HTTPException(status_code=422, detail="Attachment not found")
        await db.flush()
        attachment.message_id = message.id
    await db.commit()
    await db.refresh(message)

    # Рассылаем через WebSocket всем участникам чата
    member_ids = await _get_chat_member_ids(chat_id, db)
    await manager.broadcast_to_users(user_ids=member_ids, event=new_message_event(message, reply_to))

    return (await messages_out(db, [message]))[0]


@router.patch("/{message_id}", response_model=MessageOut)
async def edit_message(
    chat_id: str,
    message_id: str,
    body: EditMessage,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Исправить свой текст. Новый payload клиент шифрует заново, как при отправке."""
    await _assert_member(chat_id, current_user.id, db)
    message = await _chat_message(chat_id, message_id, db)
    if message.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="Исправить можно только своё сообщение")
    has_attachment = (
        await db.execute(select(Attachment.id).where(Attachment.message_id == message.id).limit(1))
    ).first()
    if has_attachment:
        raise HTTPException(status_code=422, detail="Картинку исправить нельзя")

    message.payload = body.payload
    message.edited_at = datetime.now(timezone.utc)
    await db.commit()

    await manager.broadcast_to_users(
        await _get_chat_member_ids(chat_id, db),
        {
            "type": "message_edited",
            "chat_id": chat_id,
            "message_id": message.id,
            "payload": message.payload,
            "edited_at": message.edited_at.isoformat(),
        },
    )
    return (await messages_out(db, [message]))[0]


@router.delete("/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(
    chat_id: str,
    message_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Удалить у всех: своё — всегда, чужое — владелец и админы группы."""
    me = await _assert_member(chat_id, current_user.id, db)
    message = await _chat_message(chat_id, message_id, db)
    if message.sender_id != current_user.id:
        chat_type = (await db.execute(select(Chat.type).where(Chat.id == chat_id))).scalar_one()
        if chat_type != "group" or me.role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="Удалить у всех можно только своё сообщение")

    # Картинка уходит вместе с сообщением — и с диска сразу, а не при уборке.
    attachment_ids = (
        await db.execute(select(Attachment.id).where(Attachment.message_id == message.id))
    ).scalars().all()
    await db.delete(message)
    await db.commit()
    for attachment_id in attachment_ids:
        attachment_files.delete_file(attachment_id)

    await manager.broadcast_to_users(
        await _get_chat_member_ids(chat_id, db),
        {"type": "message_deleted", "chat_id": chat_id, "message_id": message_id},
    )


@router.post("/{message_id}/hide", status_code=status.HTTP_204_NO_CONTENT)
async def hide_message(
    chat_id: str,
    message_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Удалить у меня: у собеседников сообщение остаётся."""
    await _assert_member(chat_id, current_user.id, db)
    await _chat_message(chat_id, message_id, db)
    await db.execute(
        insert(HiddenMessage)
        .values(user_id=current_user.id, message_id=message_id)
        .on_conflict_do_nothing()
    )
    await db.commit()
    # Только своим устройствам: на остальных у этого человека оно тоже пропадает.
    await manager.send_to_user(
        current_user.id,
        {"type": "message_deleted", "chat_id": chat_id, "message_id": message_id},
    )


@router.put("/{message_id}/reaction", status_code=status.HTTP_204_NO_CONTENT)
async def set_reaction(
    chat_id: str,
    message_id: str,
    body: SetReaction,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Поставить или сменить свою реакцию. В личных чатах payload — зашифрованный эмодзи."""
    await _assert_member(chat_id, current_user.id, db)
    await _chat_message(chat_id, message_id, db)
    chat_type = (await db.execute(select(Chat.type).where(Chat.id == chat_id))).scalar_one()
    if chat_type == "group" and body.payload not in REACTIONS:
        raise HTTPException(status_code=422, detail="Такой реакции нет")

    now = datetime.now(timezone.utc)
    await db.execute(
        insert(MessageReaction)
        .values(message_id=message_id, user_id=current_user.id, payload=body.payload, created_at=now)
        .on_conflict_do_update(
            index_elements=[MessageReaction.message_id, MessageReaction.user_id],
            set_={"payload": body.payload, "created_at": now},
        )
    )
    await db.commit()
    await _broadcast_reaction(db, chat_id, message_id, current_user.id, body.payload)


@router.delete("/{message_id}/reaction", status_code=status.HTTP_204_NO_CONTENT)
async def remove_reaction(
    chat_id: str,
    message_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _assert_member(chat_id, current_user.id, db)
    await _chat_message(chat_id, message_id, db)
    await db.execute(
        delete(MessageReaction).where(
            MessageReaction.message_id == message_id,
            MessageReaction.user_id == current_user.id,
        )
    )
    await db.commit()
    await _broadcast_reaction(db, chat_id, message_id, current_user.id, None)


async def _broadcast_reaction(
    db: AsyncSession, chat_id: str, message_id: str, user_id: str, payload: str | None
) -> None:
    await manager.broadcast_to_users(
        await _get_chat_member_ids(chat_id, db),
        {
            "type": "message_reaction",
            "chat_id": chat_id,
            "message_id": message_id,
            "user_id": user_id,
            "payload": payload,
        },
    )

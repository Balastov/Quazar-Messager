from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.chat import ChatMember
from app.models.message import Message
from app.models.user import User
from app.schemas.message import MessageOut, SendMessage
from app.ws.hub import manager

router = APIRouter(prefix="/chats/{chat_id}/messages", tags=["messages"])


async def _get_chat_member_ids(chat_id: str, db: AsyncSession) -> list[str]:
    result = await db.execute(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)
    )
    return [row[0] for row in result.all()]


async def _assert_member(chat_id: str, user_id: str, db: AsyncSession):
    result = await db.execute(
        select(ChatMember).where(
            ChatMember.chat_id == chat_id,
            ChatMember.user_id == user_id,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="Access denied")


@router.get("", response_model=list[MessageOut])
async def get_messages(
    chat_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(50, le=100),
    before_id: str | None = Query(None),
):
    await _assert_member(chat_id, current_user.id, db)

    query = select(Message).where(Message.chat_id == chat_id)
    if before_id:
        # курсорная пагинация по id (uuid не сортируется по времени, используем created_at)
        result = await db.execute(select(Message.created_at).where(Message.id == before_id))
        cursor_ts = result.scalar_one_or_none()
        if cursor_ts:
            query = query.where(Message.created_at < cursor_ts)

    query = query.order_by(Message.created_at.desc()).limit(limit)
    result = await db.execute(query)
    messages = result.scalars().all()
    return list(reversed(messages))


@router.post("", response_model=MessageOut, status_code=201)
async def send_message(
    chat_id: str,
    body: SendMessage,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _assert_member(chat_id, current_user.id, db)

    message = Message(chat_id=chat_id, sender_id=current_user.id, payload=body.payload)
    db.add(message)
    await db.commit()
    await db.refresh(message)

    # Рассылаем через WebSocket всем участникам чата
    member_ids = await _get_chat_member_ids(chat_id, db)
    await manager.broadcast_to_users(
        user_ids=member_ids,
        event={
            "type": "new_message",
            "message_id": message.id,
            "chat_id": chat_id,
            "sender_id": current_user.id,
            "payload": message.payload,
            "status": message.status,
            "timestamp": message.created_at.isoformat(),
        },
    )

    return message

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal
from app.core.security import decode_token
from app.models.chat import ChatMember
from app.models.message import Message
from app.ws.hub import manager

router = APIRouter()

_STATUS_RANK = {"sent": 0, "delivered": 1, "read": 2}


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str):
    user_id = decode_token(token)
    if not user_id:
        await websocket.close(code=4001)
        return

    await manager.connect(websocket, user_id)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            event_type = data.get("type")

            if event_type == "send_message":
                await _handle_send_message(data, user_id)

            elif event_type == "message_status":
                await _handle_status(data, user_id)

    except WebSocketDisconnect:
        manager.disconnect(websocket, user_id)


async def _handle_send_message(data: dict, sender_id: str):
    chat_id = data.get("chat_id")
    payload = data.get("payload")
    if not chat_id or not payload:
        return

    async with AsyncSessionLocal() as db:
        # Проверяем, что sender является участником чата
        result = await db.execute(
            select(ChatMember).where(
                ChatMember.chat_id == chat_id,
                ChatMember.user_id == sender_id,
            )
        )
        if not result.scalar_one_or_none():
            return

        message = Message(chat_id=chat_id, sender_id=sender_id, payload=payload)
        db.add(message)
        await db.flush()

        # Получаем всех участников чата
        members_result = await db.execute(
            select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)
        )
        member_ids = [row[0] for row in members_result.all()]

        await db.commit()
        await db.refresh(message)

    event = {
        "type": "new_message",
        "message_id": message.id,
        "chat_id": chat_id,
        "sender_id": sender_id,
        "payload": message.payload,
        "status": message.status,
        "timestamp": message.created_at.isoformat(),
    }
    await manager.broadcast_to_users(member_ids, event)


def _collect_message_ids(data: dict) -> list[str]:
    raw_ids = data.get("message_ids")
    if isinstance(raw_ids, list):
        return [mid for mid in raw_ids if isinstance(mid, str) and mid]
    message_id = data.get("message_id")
    if isinstance(message_id, str) and message_id:
        return [message_id]
    return []


async def _is_chat_member(db: AsyncSession, chat_id: str, user_id: str) -> bool:
    result = await db.execute(
        select(ChatMember).where(
            ChatMember.chat_id == chat_id,
            ChatMember.user_id == user_id,
        )
    )
    return result.scalar_one_or_none() is not None


async def _handle_status(data: dict, user_id: str):
    new_status = data.get("status")
    if new_status not in ("delivered", "read"):
        return

    message_ids = _collect_message_ids(data)
    if not message_ids:
        return

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique_ids: list[str] = []
    for mid in message_ids:
        if mid not in seen:
            seen.add(mid)
            unique_ids.append(mid)

    updates: list[tuple[str, str, str]] = []  # message_id, status, sender_id

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Message).where(Message.id.in_(unique_ids)))
        messages = list(result.scalars().all())
        if not messages:
            return

        member_cache: dict[str, bool] = {}
        for message in messages:
            if message.sender_id == user_id:
                continue

            chat_id = message.chat_id
            if chat_id not in member_cache:
                member_cache[chat_id] = await _is_chat_member(db, chat_id, user_id)
            if not member_cache[chat_id]:
                continue

            current = str(message.status)
            if _STATUS_RANK.get(new_status, -1) <= _STATUS_RANK.get(current, -1):
                continue

            message.status = new_status
            if message.sender_id:
                updates.append((message.id, new_status, message.sender_id))

        if updates:
            await db.commit()

    for message_id, status, sender_id in updates:
        await manager.send_to_user(
            sender_id,
            {
                "type": "message_status",
                "message_id": message_id,
                "status": status,
                "updated_by": user_id,
            },
        )

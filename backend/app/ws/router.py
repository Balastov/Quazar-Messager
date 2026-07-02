import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal
from app.core.security import decode_token
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.ws.hub import manager

router = APIRouter()


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


async def _handle_status(data: dict, user_id: str):
    message_id = data.get("message_id")
    new_status = data.get("status")
    if not message_id or new_status not in ("delivered", "read"):
        return

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Message).where(Message.id == message_id))
        message = result.scalar_one_or_none()
        if not message:
            return

        message.status = new_status
        await db.commit()

        # Уведомляем отправителя об изменении статуса
        if message.sender_id:
            await manager.send_to_user(
                message.sender_id,
                {
                    "type": "message_status",
                    "message_id": message_id,
                    "status": new_status,
                    "updated_by": user_id,
                },
            )

import asyncio
import json
from datetime import datetime

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.security import decode_token
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.user import User
from app.core import presence
from app.api.messages import deliver
from app.ws import calls as call_signaling
from app.ws import typing as typing_signals
from app.ws.hub import manager

router = APIRouter()

_STATUS_RANK = {"sent": 0, "delivered": 1, "read": 2}


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str, state: str = "active"):
    user_id = decode_token(token)
    if not user_id:
        await websocket.close(code=4001)
        return
    async with AsyncSessionLocal() as db:
        blocked = (await db.execute(select(User.blocked_at).where(User.id == user_id))).scalar_one_or_none()
    if blocked:
        await websocket.close(code=4001)
        return

    await manager.connect(websocket, user_id)
    # state=idle — подключились в фоне (свёрнутый телефон): не мигаем «в сети».
    await presence.on_connect(user_id, websocket, active=state != "idle")
    await call_signaling.deliver_pending_invites(user_id)
    heartbeats = False  # the client sends pings — silence mid-call then means it is gone
    try:
        while True:
            timeout = (
                settings.CALL_HEARTBEAT_TIMEOUT_SEC
                if heartbeats and call_signaling.ws_in_active_call(user_id, websocket)
                else None
            )
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout)
            except asyncio.TimeoutError:
                await websocket.close(code=4008)
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            event_type = data.get("type")

            if event_type == "ping":
                heartbeats = True
                await manager.send(websocket, {"type": "pong"})

            elif event_type == "activity":
                await presence.on_activity(user_id, websocket, data.get("state") != "idle")

            elif event_type == "send_message":
                await _handle_send_message(data, user_id)

            elif event_type == "message_status":
                await _handle_status(data, user_id)

            elif event_type == "typing":
                await typing_signals.handle_typing(data, user_id)

            elif isinstance(event_type, str) and event_type.startswith("call_"):
                await call_signaling.handle_call_event(data, user_id, websocket)

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, user_id)
        await call_signaling.on_user_offline(user_id, websocket)
        await presence.on_disconnect(user_id, websocket)


async def _handle_send_message(data: dict, sender_id: str):
    """Отправка по WebSocket — по тем же правилам, что и POST /chats/{id}/messages."""
    chat_id = data.get("chat_id")
    payload = data.get("payload")
    if not isinstance(chat_id, str) or not isinstance(payload, str) or not payload:
        return

    async with AsyncSessionLocal() as db:
        if not await _is_chat_member(db, chat_id, sender_id):
            return
        chat = (await db.execute(select(Chat).where(Chat.id == chat_id))).scalar_one()
        try:
            await deliver(db, chat, sender_id, payload)
        except HTTPException:
            return


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
    # Прочитал до: chat_id -> самое свежее из прочитанных сейчас сообщений.
    read_up_to: dict[str, datetime] = {}

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

            if new_status == "read" and (
                chat_id not in read_up_to or message.created_at > read_up_to[chat_id]
            ):
                read_up_to[chat_id] = message.created_at

            current = str(message.status)
            if _STATUS_RANK.get(new_status, -1) <= _STATUS_RANK.get(current, -1):
                continue

            message.status = new_status
            if message.sender_id:
                updates.append((message.id, new_status, message.sender_id))

        # В группах статус сообщения общий: свои непрочитанные считаются по этой отметке.
        for chat_id, ts in read_up_to.items():
            await db.execute(
                update(ChatMember)
                .where(
                    ChatMember.chat_id == chat_id,
                    ChatMember.user_id == user_id,
                    or_(ChatMember.last_read_at.is_(None), ChatMember.last_read_at < ts),
                )
                .values(last_read_at=ts)
            )

        if updates or read_up_to:
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

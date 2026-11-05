import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.security import decode_token, token_is_current
from app.models.chat import Chat, ChatMember
from app.models.message import Message, MessageReadReceipt
from app.models.user import User
from app.core import presence, device_sessions
from app.api.messages import deliver, visible_to
from app.ws import calls as call_signaling
from app.ws import typing as typing_signals
from app.core import room_activities
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
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if not user or user.blocked_at or not token_is_current(token, user):
            await websocket.close(code=4001)
            return
        try:
            session = await device_sessions.ensure(db, token, user, websocket.headers.get("user-agent", "") if hasattr(websocket, "headers") else "")
        except HTTPException:
            await websocket.close(code=4001)
            return
        websocket._quazar_session_id = session.id

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
                else 30
            )
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout)
            except asyncio.TimeoutError:
                if heartbeats and call_signaling.ws_in_active_call(user_id, websocket):
                    await websocket.close(code=4008)
                    break
                raw = None
            async with AsyncSessionLocal() as db:
                current = await db.get(User, user_id)
                try:
                    if not current or current.blocked_at:
                        raise HTTPException(status_code=401)
                    await device_sessions.ensure(db, token, current)
                except HTTPException:
                    await websocket.close(code=4001)
                    break
            if raw is None:
                continue
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

            elif event_type == "room_pointer":
                await room_activities.handle_pointer(data, user_id)

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
            hints = data.get("notification_mentions", [])
            if not isinstance(hints, list) or len(hints) > 100 or any(not isinstance(uid, str) or len(uid) > 36 for uid in hints):
                hints = []
            await deliver(db, chat, sender_id, payload, notification_mentions=hints)
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
        if len(unique_ids) >= 512:
            break

    updates: list[tuple[str, str, str]] = []  # message_id, status, sender_id
    # Прочитал до: chat_id -> самое свежее из прочитанных сейчас сообщений.
    read_up_to: dict[str, datetime] = {}
    receipt_events: list[tuple[str, dict]] = []
    acknowledged: list[str] = []

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Message, Chat.type).join(Chat, Chat.id == Message.chat_id).join(
            ChatMember, ChatMember.chat_id == Message.chat_id
        ).where(ChatMember.user_id == user_id, Message.id.in_(unique_ids), visible_to(user_id))
            .order_by(Message.id).with_for_update(of=Message))
        rows = result.all()
        messages = [message for message, _ in rows]
        if not messages:
            return

        member_cache = {message.chat_id: chat_type for message, chat_type in rows}
        receipt_rows = []
        now = datetime.now(timezone.utc)
        for message in messages:
            if message.sender_id == user_id:
                continue

            chat_id = message.chat_id
            if new_status == "read" and member_cache[chat_id] == "group":
                receipt_rows.append({"message_id": message.id, "user_id": user_id, "read_at": now})
                acknowledged.append(message.id)

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

        if receipt_rows:
            inserted = (await db.execute(insert(MessageReadReceipt).values(receipt_rows).on_conflict_do_nothing(
                index_elements=[MessageReadReceipt.message_id, MessageReadReceipt.user_id]
            ).returning(MessageReadReceipt.message_id))).scalars().all()
            by_id = {message.id: message for message in messages}
            for message_id in inserted:
                message = by_id[message_id]
                if message.sender_id:
                    receipt_events.append((message.sender_id, {"type": "message_read", "chat_id": message.chat_id, "message_id": message_id}))

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

        # Автор, вышедший из чата, не получает новые сведения об активности группы.
        recipients = {(row[0], row[1]) for row in (await db.execute(select(ChatMember.chat_id, ChatMember.user_id).where(
            ChatMember.chat_id.in_({m.chat_id for m in messages}),
            ChatMember.user_id.in_({m.sender_id for m in messages if m.sender_id})
        ))).all()}
        status_changed = bool(updates)
        by_id = {message.id: message for message in messages}
        updates = [(mid, status, sender) for mid, status, sender in updates if (by_id[mid].chat_id, sender) in recipients]
        receipt_events = [(sender, event) for sender, event in receipt_events if (event["chat_id"], sender) in recipients]
        if status_changed or read_up_to or receipt_rows:
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
    for sender_id, event in receipt_events:
        await manager.send_to_user(sender_id, event)
    if acknowledged:
        await manager.send_to_user(user_id, {"type": "message_read_ack", "message_ids": acknowledged})

"""In-memory active call registry + WebSocket call signaling handlers.

Protocol (extensible):
  client → server:
    call_invite  { call_id?, chat_id, callee_id, media: {audio, video} }
    call_accept  { call_id }
    call_reject  { call_id, reason? }
    call_hangup  { call_id, reason? }
    call_offer   { call_id, sdp }
    call_answer  { call_id, sdp }
    call_ice     { call_id, candidate }
    call_resume  { call_id, device_id? } — the device is back after a dropped connection
    call_media   { call_id, video, screen } — my camera / screen share went on or off mid-call
  (call_invite / call_accept may carry device_id — a per-tab id that lets a device resume
  even before the server notices its old connection is dead)

  server → client (relay / control):
    call_invite | call_ringing | call_accept | call_reject | call_hangup
    call_offer | call_answer | call_ice | call_media
    call_unavailable | call_busy | call_error
    call_reconnecting | call_reconnected { call_id, user_id } — the peer lost / regained connection
    call_resumed | call_resume_failed { call_id } — reply to call_resume

  Multi-device: a call is bound to the caller's connection that sent the invite and the
  callee's connection that accepted it. Offer/answer/ICE go only to those connections, the
  callee's other devices get call_hangup { reason: "answered_elsewhere" }, and signaling or
  hangups from a participant's other devices are ignored.

  Reconnect: when the device an active call runs on disconnects, the call waits
  CALL_RECONNECT_GRACE_SEC for call_resume from a new connection before hanging up.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.blocks import block_state
from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.push import send_push_to_user, user_has_push
from app.models.call import Call
from app.models.chat import Chat, ChatMember
from app.models.user import User
from app.ws.hub import manager


@dataclass
class ActiveCall:
    id: str
    chat_id: str
    caller_id: str
    callee_id: str
    media: str  # audio | video | audio_video
    status: str = "ringing"  # ringing | active
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    timeout_task: asyncio.Task | None = field(default=None, repr=False)
    # WebSocket the call runs on for each side (None — not bound yet: any device).
    caller_ws: Any = field(default=None, repr=False, compare=False)
    callee_ws: Any = field(default=None, repr=False, compare=False)
    caller_device: str | None = None
    callee_device: str | None = None
    # user_id → task that hangs up unless the user comes back in time.
    reconnect_tasks: dict[str, asyncio.Task] = field(default_factory=dict, repr=False, compare=False)


# call_id → ActiveCall
_active: dict[str, ActiveCall] = {}
# user_id → call_id (at most one active/ringing call per user for MVP)
_user_call: dict[str, str] = {}


def get_active_call(call_id: str) -> ActiveCall | None:
    return _active.get(call_id)


def user_busy(user_id: str) -> bool:
    return user_id in _user_call


def _media_from_payload(data: dict) -> str:
    media = data.get("media") or {}
    if not isinstance(media, dict):
        media = {}
    audio = bool(media.get("audio", True))
    video = bool(media.get("video", False))
    if video and audio:
        return "audio_video"
    if video:
        return "video"
    return "audio"


def _cancel_timeout(call: ActiveCall) -> None:
    task = call.timeout_task
    call.timeout_task = None
    if task and not task.done():
        task.cancel()


def _register(call: ActiveCall) -> None:
    _active[call.id] = call
    _user_call[call.caller_id] = call.id
    _user_call[call.callee_id] = call.id


def _unregister(call_id: str) -> ActiveCall | None:
    call = _active.pop(call_id, None)
    if not call:
        return None
    _cancel_timeout(call)
    current = asyncio.current_task()
    for task in call.reconnect_tasks.values():
        if task is not current and not task.done():
            task.cancel()
    call.reconnect_tasks.clear()
    if _user_call.get(call.caller_id) == call_id:
        _user_call.pop(call.caller_id, None)
    if _user_call.get(call.callee_id) == call_id:
        _user_call.pop(call.callee_id, None)
    return call


def _peer_id(call: ActiveCall, user_id: str) -> str | None:
    if user_id == call.caller_id:
        return call.callee_id
    if user_id == call.callee_id:
        return call.caller_id
    return None


def _bound_ws(call: ActiveCall, user_id: str) -> Any:
    if user_id == call.caller_id:
        return call.caller_ws
    if user_id == call.callee_id:
        return call.callee_ws
    return None


def _device_id(data: dict) -> str | None:
    device = data.get("device_id")
    return device if isinstance(device, str) and 0 < len(device) <= 64 else None


def _bound_device(call: ActiveCall, user_id: str) -> str | None:
    if user_id == call.caller_id:
        return call.caller_device
    if user_id == call.callee_id:
        return call.callee_device
    return None


def _from_other_device(call: ActiveCall, user_id: str, ws: Any) -> bool:
    """The event came from a participant's device that is not the one the call runs on."""
    bound = _bound_ws(call, user_id)
    return ws is not None and bound is not None and bound is not ws


async def _send_to_call_device(call: ActiveCall, user_id: str, event: dict) -> None:
    bound = _bound_ws(call, user_id)
    if bound is None:
        await manager.send_to_user(user_id, event)
    elif bound in manager.user_connections.get(user_id, []):
        await manager.send(bound, event)
    # Otherwise the device is reconnecting: it renegotiates after call_resume.


def _bind(call: ActiveCall, user_id: str, ws: Any) -> None:
    if user_id == call.caller_id:
        call.caller_ws = ws
    elif user_id == call.callee_id:
        call.callee_ws = ws


def ws_in_active_call(user_id: str, ws: Any) -> bool:
    """This connection carries an active call (heartbeat silence there means the device is gone)."""
    call_id = _user_call.get(user_id)
    call = get_active_call(call_id) if call_id else None
    return bool(call and call.status == "active" and _bound_ws(call, user_id) is ws)


def _invite_payload(call: ActiveCall) -> dict:
    return {
        "type": "call_invite",
        "call_id": call.id,
        "chat_id": call.chat_id,
        "caller_id": call.caller_id,
        "callee_id": call.callee_id,
        "media": {
            "audio": call.media != "video",
            "video": call.media in ("video", "audio_video"),
        },
    }


async def _username(user_id: str) -> str:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User.username).where(User.id == user_id))
        name = result.scalar_one_or_none()
        return name or "Собеседник"


async def _assert_direct_member(db: AsyncSession, chat_id: str, user_id: str, peer_id: str) -> bool:
    chat = (
        await db.execute(select(Chat).where(Chat.id == chat_id, Chat.type == "direct"))
    ).scalar_one_or_none()
    if not chat:
        return False
    members = (
        await db.execute(select(ChatMember.user_id).where(ChatMember.chat_id == chat_id))
    ).scalars().all()
    member_set = set(members)
    return user_id in member_set and peer_id in member_set


async def _persist_create(call: ActiveCall) -> None:
    async with AsyncSessionLocal() as db:
        db.add(
            Call(
                id=call.id,
                chat_id=call.chat_id,
                caller_id=call.caller_id,
                callee_id=call.callee_id,
                media=call.media,
                status="ringing",
            )
        )
        await db.commit()


async def _persist_status(
    call_id: str,
    status: str,
    *,
    answered: bool = False,
    ended: bool = False,
) -> None:
    async with AsyncSessionLocal() as db:
        row = (await db.execute(select(Call).where(Call.id == call_id))).scalar_one_or_none()
        if not row:
            return
        row.status = status
        now = datetime.now(timezone.utc)
        if answered and row.answered_at is None:
            row.answered_at = now
        if ended:
            row.ended_at = now
            if row.answered_at:
                row.duration_sec = max(0, int((now - row.answered_at).total_seconds()))
        await db.commit()


async def _ring_timeout(call_id: str) -> None:
    try:
        await asyncio.sleep(max(10, int(settings.CALL_RING_TIMEOUT_SEC)))
    except asyncio.CancelledError:
        return

    call = get_active_call(call_id)
    if not call or call.status != "ringing":
        return

    _unregister(call_id)
    await _persist_status(call_id, "missed", ended=True)
    event = {
        "type": "call_hangup",
        "call_id": call_id,
        "chat_id": call.chat_id,
        "ended_by": "system",
        "reason": "timeout",
    }
    await manager.send_to_user(call.caller_id, event)
    await manager.send_to_user(call.callee_id, event)


def _schedule_timeout(call: ActiveCall) -> None:
    _cancel_timeout(call)
    call.timeout_task = asyncio.create_task(_ring_timeout(call.id))


async def handle_call_event(data: dict, user_id: str, ws: Any = None) -> None:
    event_type = data.get("type")
    if event_type == "call_invite":
        await _handle_invite(data, user_id, ws)
    elif event_type == "call_accept":
        await _handle_accept(data, user_id, ws)
    elif event_type == "call_reject":
        await _handle_reject(data, user_id, ws)
    elif event_type == "call_hangup":
        await _handle_hangup(data, user_id, ws)
    elif event_type in ("call_offer", "call_answer", "call_ice", "call_media"):
        await _relay_signaling(data, user_id, ws)
    elif event_type == "call_resume":
        await _handle_resume(data, user_id, ws)
    else:
        await manager.send_to_user(
            user_id,
            {"type": "call_error", "error": "unknown_call_event", "detail": event_type},
        )


async def deliver_pending_invites(user_id: str) -> None:
    """Re-send ringing invite when callee reconnects (e.g. opened from push)."""
    call_id = _user_call.get(user_id)
    if not call_id:
        return
    call = get_active_call(call_id)
    if not call or call.callee_id != user_id or call.status != "ringing":
        return
    await manager.send_to_user(user_id, _invite_payload(call))


async def _handle_invite(data: dict, caller_id: str, ws: Any = None) -> None:
    chat_id = data.get("chat_id")
    callee_id = data.get("callee_id")
    if not isinstance(chat_id, str) or not isinstance(callee_id, str):
        await manager.send_to_user(caller_id, {"type": "call_error", "error": "invalid_invite"})
        return
    if callee_id == caller_id:
        await manager.send_to_user(caller_id, {"type": "call_error", "error": "cannot_call_self"})
        return
    if user_busy(caller_id):
        await manager.send_to_user(caller_id, {"type": "call_error", "error": "already_in_call"})
        return

    call_id = data.get("call_id") if isinstance(data.get("call_id"), str) else str(uuid.uuid4())
    media = _media_from_payload(data)

    async with AsyncSessionLocal() as db:
        ok = await _assert_direct_member(db, chat_id, caller_id, callee_id)
        i_blocked, they_blocked = await block_state(db, caller_id, callee_id) if ok else (False, False)
    if not ok:
        await manager.send_to_user(caller_id, {"type": "call_error", "error": "not_allowed"})
        return
    if i_blocked:
        await manager.send_to_user(caller_id, {"type": "call_error", "error": "blocked"})
        return
    if they_blocked:
        # Заблокировавший звонка не видит; звонящему — как будто собеседник не в сети.
        await _persist_missed(call_id, chat_id, caller_id, callee_id, media)
        await manager.send_to_user(
            caller_id,
            {
                "type": "call_unavailable",
                "call_id": call_id,
                "chat_id": chat_id,
                "callee_id": callee_id,
                "reason": "offline",
            },
        )
        return

    if user_busy(callee_id):
        await _persist_busy_record(call_id, chat_id, caller_id, callee_id, media)
        await manager.send_to_user(
            caller_id,
            {
                "type": "call_busy",
                "call_id": call_id,
                "chat_id": chat_id,
                "callee_id": callee_id,
            },
        )
        return

    online = bool(manager.user_connections.get(callee_id))
    has_push = await user_has_push(callee_id)
    if not online and not has_push:
        await _persist_missed(call_id, chat_id, caller_id, callee_id, media)
        await manager.send_to_user(
            caller_id,
            {
                "type": "call_unavailable",
                "call_id": call_id,
                "chat_id": chat_id,
                "callee_id": callee_id,
                "reason": "offline",
            },
        )
        return

    call = ActiveCall(
        id=call_id,
        chat_id=chat_id,
        caller_id=caller_id,
        callee_id=callee_id,
        media=media,
        caller_ws=ws,
        caller_device=_device_id(data),
    )
    _register(call)
    await _persist_create(call)
    _schedule_timeout(call)

    payload = _invite_payload(call)
    if online:
        await manager.send_to_user(callee_id, payload)

    caller_name = await _username(caller_id)
    await send_push_to_user(
        callee_id,
        {
            "type": "incoming_call",
            "call_id": call.id,
            "chat_id": chat_id,
            "caller_id": caller_id,
            "caller_name": caller_name,
            "media": payload["media"],
        },
    )

    await manager.send_to_user(
        caller_id,
        {
            "type": "call_ringing",
            "call_id": call.id,
            "chat_id": chat_id,
            "callee_id": callee_id,
            "media": payload["media"],
        },
    )


async def _persist_busy_record(
    call_id: str, chat_id: str, caller_id: str, callee_id: str, media: str
) -> None:
    async with AsyncSessionLocal() as db:
        db.add(
            Call(
                id=call_id,
                chat_id=chat_id,
                caller_id=caller_id,
                callee_id=callee_id,
                media=media,
                status="busy",
                ended_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()


async def _persist_missed(
    call_id: str, chat_id: str, caller_id: str, callee_id: str, media: str
) -> None:
    async with AsyncSessionLocal() as db:
        db.add(
            Call(
                id=call_id,
                chat_id=chat_id,
                caller_id=caller_id,
                callee_id=callee_id,
                media=media,
                status="missed",
                ended_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()


async def _handle_accept(data: dict, user_id: str, ws: Any = None) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call or call.callee_id != user_id or call.status != "ringing":
        await manager.send_to_user(
            user_id, {"type": "call_error", "error": "invalid_accept", "call_id": call_id}
        )
        return

    _cancel_timeout(call)
    call.status = "active"
    call.callee_ws = ws
    call.callee_device = _device_id(data)
    await _persist_status(call_id, "active", answered=True)
    event = {
        "type": "call_accept",
        "call_id": call_id,
        "chat_id": call.chat_id,
        "accepted_by": user_id,
    }
    await manager.send_to_user(call.caller_id, event)
    if ws is None:
        await manager.send_to_user(call.callee_id, event)
        return
    await manager.send(ws, event)
    # The callee's other devices stop ringing and stay out of the call.
    elsewhere = {
        "type": "call_hangup",
        "call_id": call_id,
        "chat_id": call.chat_id,
        "ended_by": user_id,
        "reason": "answered_elsewhere",
    }
    for other in list(manager.user_connections.get(call.callee_id, [])):
        if other is not ws:
            await manager.send(other, elsewhere)


async def _handle_reject(data: dict, user_id: str, ws: Any = None) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call or call.callee_id != user_id or _from_other_device(call, user_id, ws):
        return
    reason = data.get("reason") if isinstance(data.get("reason"), str) else "rejected"
    _unregister(call_id)
    await _persist_status(call_id, "rejected", ended=True)
    event = {
        "type": "call_reject",
        "call_id": call_id,
        "chat_id": call.chat_id,
        "rejected_by": user_id,
        "reason": reason,
    }
    await manager.send_to_user(call.caller_id, event)
    await manager.send_to_user(call.callee_id, event)


async def _handle_hangup(data: dict, user_id: str, ws: Any = None) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call or user_id not in (call.caller_id, call.callee_id):
        return
    if _from_other_device(call, user_id, ws):
        return

    was_ringing = call.status == "ringing"
    _unregister(call_id)
    final_status = "missed" if was_ringing and user_id == call.caller_id else "ended"
    if was_ringing and user_id == call.callee_id:
        final_status = "rejected"
    await _persist_status(call_id, final_status, ended=True)

    event = {
        "type": "call_hangup",
        "call_id": call_id,
        "chat_id": call.chat_id,
        "ended_by": user_id,
        "reason": data.get("reason") if isinstance(data.get("reason"), str) else "hangup",
    }
    await manager.send_to_user(call.caller_id, event)
    await manager.send_to_user(call.callee_id, event)


async def _relay_signaling(data: dict, user_id: str, ws: Any = None) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call or _from_other_device(call, user_id, ws):
        return
    peer = _peer_id(call, user_id)
    if not peer:
        return

    event_type = data.get("type")
    if event_type in ("call_offer", "call_answer"):
        sdp = data.get("sdp")
        if not isinstance(sdp, dict):
            return
        await _send_to_call_device(
            call,
            peer,
            {"type": event_type, "call_id": call_id, "sdp": sdp, "from_user_id": user_id},
        )
    elif event_type == "call_media":
        await _send_to_call_device(
            call,
            peer,
            {
                "type": "call_media",
                "call_id": call_id,
                "video": data.get("video") is True,
                "screen": data.get("screen") is True,
                "from_user_id": user_id,
            },
        )
    elif event_type == "call_ice":
        candidate = data.get("candidate")
        await _send_to_call_device(
            call,
            peer,
            {
                "type": "call_ice",
                "call_id": call_id,
                "candidate": candidate,
                "from_user_id": user_id,
            },
        )


def _reconnect_grace() -> float:
    return max(1, int(settings.CALL_RECONNECT_GRACE_SEC))


async def _reconnect_timeout(call_id: str, user_id: str) -> None:
    try:
        await asyncio.sleep(_reconnect_grace())
    except asyncio.CancelledError:
        return
    call = get_active_call(call_id)
    if not call or call.reconnect_tasks.pop(user_id, None) is None:
        return
    await _handle_hangup(
        {"call_id": call_id, "reason": "disconnect"}, user_id, _bound_ws(call, user_id)
    )


async def _handle_resume(data: dict, user_id: str, ws: Any = None) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    failed = {"type": "call_resume_failed", "call_id": call_id}
    if not call or user_id not in (call.caller_id, call.callee_id) or ws is None:
        if ws is not None:
            await manager.send(ws, failed)
        return
    bound = _bound_ws(call, user_id)
    stale = None
    if bound is not None and bound is not ws and bound in manager.user_connections.get(user_id, []):
        device = _device_id(data)
        if device is None or device != _bound_device(call, user_id):
            # The call is alive on another device of this user.
            await manager.send(ws, failed)
            return
        stale = bound  # same device, its old connection just has not timed out yet

    _bind(call, user_id, ws)
    if stale is not None:
        try:
            await stale.close()
        except Exception:
            pass
    task = call.reconnect_tasks.pop(user_id, None)
    if task is not None:
        task.cancel()
    await manager.send(ws, {"type": "call_resumed", "call_id": call_id})
    if bound is not ws:
        # The peer renegotiates the media path towards the new connection.
        peer = _peer_id(call, user_id)
        if peer:
            await _send_to_call_device(
                call, peer, {"type": "call_reconnected", "call_id": call_id, "user_id": user_id}
            )


async def on_user_offline(user_id: str, ws: Any = None) -> None:
    """When the device an active call runs on disconnects, give it CALL_RECONNECT_GRACE_SEC to
    come back (call_resume) before hanging up; keep ringing so push can wake the callee.
    Closing another device of the same user does not touch the call."""
    call_id = _user_call.get(user_id)
    if not call_id:
        return
    call = get_active_call(call_id)
    if not call or call.status == "ringing":
        return
    bound = _bound_ws(call, user_id)
    if bound is not None and ws is not None:
        if bound is not ws:
            return
    elif manager.user_connections.get(user_id):
        return
    if user_id in call.reconnect_tasks:
        return
    call.reconnect_tasks[user_id] = asyncio.create_task(_reconnect_timeout(call_id, user_id))
    peer = _peer_id(call, user_id)
    if peer:
        await _send_to_call_device(
            call, peer, {"type": "call_reconnecting", "call_id": call_id, "user_id": user_id}
        )


async def list_history_for_user(db: AsyncSession, user_id: str, limit: int = 50) -> list[Call]:
    result = await db.execute(
        select(Call)
        .where(or_(Call.caller_id == user_id, Call.callee_id == user_id))
        .order_by(Call.started_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())

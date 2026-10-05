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

  server → client (relay / control):
    call_invite | call_ringing | call_accept | call_reject | call_hangup
    call_offer | call_answer | call_ice
    call_unavailable | call_busy | call_error
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal
from app.models.call import Call
from app.models.chat import Chat, ChatMember
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


def _register(call: ActiveCall) -> None:
    _active[call.id] = call
    _user_call[call.caller_id] = call.id
    _user_call[call.callee_id] = call.id


def _unregister(call_id: str) -> ActiveCall | None:
    call = _active.pop(call_id, None)
    if not call:
        return None
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


async def handle_call_event(data: dict, user_id: str) -> None:
    event_type = data.get("type")
    if event_type == "call_invite":
        await _handle_invite(data, user_id)
    elif event_type == "call_accept":
        await _handle_accept(data, user_id)
    elif event_type == "call_reject":
        await _handle_reject(data, user_id)
    elif event_type == "call_hangup":
        await _handle_hangup(data, user_id)
    elif event_type in ("call_offer", "call_answer", "call_ice"):
        await _relay_signaling(data, user_id)
    else:
        await manager.send_to_user(
            user_id,
            {"type": "call_error", "error": "unknown_call_event", "detail": event_type},
        )


async def _handle_invite(data: dict, caller_id: str) -> None:
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
    if not ok:
        await manager.send_to_user(caller_id, {"type": "call_error", "error": "not_allowed"})
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

    if not manager.user_connections.get(callee_id):
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
    )
    _register(call)
    await _persist_create(call)

    payload = {
        "type": "call_invite",
        "call_id": call.id,
        "chat_id": chat_id,
        "caller_id": caller_id,
        "callee_id": callee_id,
        "media": {"audio": media != "video", "video": media in ("video", "audio_video")},
    }
    await manager.send_to_user(callee_id, payload)
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


async def _handle_accept(data: dict, user_id: str) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call or call.callee_id != user_id or call.status != "ringing":
        await manager.send_to_user(user_id, {"type": "call_error", "error": "invalid_accept", "call_id": call_id})
        return

    call.status = "active"
    await _persist_status(call_id, "active", answered=True)
    event = {
        "type": "call_accept",
        "call_id": call_id,
        "chat_id": call.chat_id,
        "accepted_by": user_id,
    }
    await manager.send_to_user(call.caller_id, event)
    await manager.send_to_user(call.callee_id, event)


async def _handle_reject(data: dict, user_id: str) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call or call.callee_id != user_id:
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


async def _handle_hangup(data: dict, user_id: str) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call or user_id not in (call.caller_id, call.callee_id):
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


async def _relay_signaling(data: dict, user_id: str) -> None:
    call_id = data.get("call_id")
    if not isinstance(call_id, str):
        return
    call = get_active_call(call_id)
    if not call:
        return
    peer = _peer_id(call, user_id)
    if not peer:
        return

    event_type = data.get("type")
    if event_type in ("call_offer", "call_answer"):
        sdp = data.get("sdp")
        if not isinstance(sdp, dict):
            return
        await manager.send_to_user(
            peer,
            {"type": event_type, "call_id": call_id, "sdp": sdp, "from_user_id": user_id},
        )
    elif event_type == "call_ice":
        candidate = data.get("candidate")
        # null candidate = end-of-candidates; still forward
        await manager.send_to_user(
            peer,
            {
                "type": "call_ice",
                "call_id": call_id,
                "candidate": candidate,
                "from_user_id": user_id,
            },
        )


async def on_user_offline(user_id: str) -> None:
    """If the user has no more sockets, end any ringing/active call."""
    if manager.user_connections.get(user_id):
        return
    call_id = _user_call.get(user_id)
    if not call_id:
        return
    call = get_active_call(call_id)
    if not call:
        return
    await _handle_hangup({"call_id": call_id, "reason": "disconnect"}, user_id)


async def list_history_for_user(db: AsyncSession, user_id: str, limit: int = 50) -> list[Call]:
    result = await db.execute(
        select(Call)
        .where(or_(Call.caller_id == user_id, Call.callee_id == user_id))
        .order_by(Call.started_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())

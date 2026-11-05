"""Серверные часы и временные метки на демонстрации. Голос остаётся в LiveKit."""

import time
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import DateTime, cast, func, or_, select

from app.core import voice
from app.core.database import AsyncSessionLocal
from app.models.room_activity import RoomActivity
from app.models.star import Star, StarMember
from app.models.user import User
from app.schemas.room_activity import PointerBody
from app.ws.hub import manager

session_factory = AsyncSessionLocal
_pointer_times: dict[tuple[str, str], float] = {}


def now() -> datetime:
    return datetime.now(timezone.utc)


def members(channel_id: str) -> list[str]:
    return [p.user_id for p in voice.participants(channel_id) if not voice.is_guest(p.user_id)]


async def broadcast(channel_id: str, event: dict) -> None:
    await manager.broadcast_to_users(members(channel_id), event)


def advance_focus(focus: dict, at: datetime) -> dict:
    if not focus.get("running") or not focus.get("ends_at"):
        return focus
    deadline = datetime.fromisoformat(focus["ends_at"])
    if at < deadline:
        return focus
    out = dict(focus)
    if out["phase"] == "work":
        out.update(phase="break", ends_at=(deadline + timedelta(seconds=out["break_seconds"])).isoformat(),
                   remaining_seconds=out["break_seconds"], version=out["version"] + 1)
        deadline = datetime.fromisoformat(out["ends_at"])
    if at >= deadline:
        out.update(phase="done", running=False, ends_at=None, remaining_seconds=0, version=out["version"] + 1)
    return out


def focus_remaining(focus: dict, at: datetime) -> float:
    if focus.get("running") and focus.get("ends_at"):
        return max(0, (datetime.fromisoformat(focus["ends_at"]) - at).total_seconds())
    return float(focus.get("remaining_seconds", 0))


def video_position(video: dict, at: datetime) -> float:
    position = float(video.get("position", 0))
    if video.get("playing") and video.get("updated_at"):
        position += max(0, (at - datetime.fromisoformat(video["updated_at"])).total_seconds())
    return min(position, video.get("duration") or 86400)


async def tick(db, at: datetime | None = None) -> int:
    from app.api.room_activities import state_event, videos

    at = at or now()
    due_focus = RoomActivity.focus["running"].as_boolean().is_(True) & (RoomActivity.focus["ends_at"].as_string() <= at.isoformat())
    video_end = (func.extract("epoch", cast(RoomActivity.video["updated_at"].as_string(), DateTime(timezone=True)))
                 + RoomActivity.video["duration"].as_float() - RoomActivity.video["position"].as_float())
    due_video = RoomActivity.video["playing"].as_boolean().is_(True) & (video_end <= at.timestamp())
    rows = (await db.execute(select(RoomActivity).where(or_(due_focus, due_video))
                             .order_by(RoomActivity.channel_id).limit(100)
                             .with_for_update(skip_locked=True))).scalars().all()
    changed = []
    for row in rows:
        focus = advance_focus(row.focus, at)
        video = row.video
        if video.get("playing") and video.get("duration") and video_position(video, at) >= video["duration"]:
            queue = await videos(db, row.channel_id)
            ids = [file["id"] for file in queue]
            for _ in range(len(queue) + 1):
                if not video.get("playing") or not video.get("duration") or video_position(video, at) < video["duration"]:
                    break
                end = datetime.fromisoformat(video["updated_at"]) + timedelta(seconds=max(0, video["duration"] - video["position"]))
                index = ids.index(video["file_id"]) + 1 if video.get("file_id") in ids else len(ids)
                file = queue[index] if index < len(queue) else None
                video = {**video, "file_id": file["id"] if file else None, "duration": file["duration"] if file else None,
                         "playing": bool(file), "position": 0, "updated_at": end.isoformat(), "version": video["version"] + 1}
        if focus != row.focus or video != row.video:
            row.focus = focus
            row.video = video
            row.revision += 1
            changed.append(row)
    await db.commit()
    for row in changed:
        await state_event(db, row)
    return len(changed)


async def handle_pointer(data: dict, user_id: str) -> None:
    try:
        body = PointerBody.model_validate(data)
    except ValidationError:
        return
    if user_id not in members(body.channel_id):
        return
    sharer = voice.screen_sharer(body.channel_id)
    if not sharer or sharer.user_id != body.sharer_id:
        return
    key, stamp = (user_id, body.channel_id), time.monotonic()
    if stamp - _pointer_times.get(key, -1) < 0.25:
        return
    _pointer_times[key] = stamp
    if len(_pointer_times) > 5000:
        for stale in [k for k, value in _pointer_times.items() if stamp - value > 60]:
            _pointer_times.pop(stale, None)
    async with session_factory() as db:
        row = await db.get(RoomActivity, body.channel_id)
        member = (await db.execute(select(StarMember).where(
            StarMember.star_id == body.star_id, StarMember.user_id == user_id,
        ))).scalar_one_or_none()
        user = await db.get(User, user_id)
        if not row or row.star_id != body.star_id or row.pointers_sharer_id != body.sharer_id or not member or not user:
            return
        from app.api.stars import assert_can_post
        star = await db.get(Star, body.star_id)
        if not star or user.blocked_at:
            return
        try:
            assert_can_post(star, member)
        except HTTPException:
            return
        await broadcast(body.channel_id, {
            "type": "room_pointer", **body.model_dump(), "user_id": user_id,
            "name": member.pseudonym or user.display_name, "created_at": now().isoformat(),
        })

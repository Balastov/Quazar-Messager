"""Кто в сети: есть хотя бы одно открытое WebSocket-соединение.

- Статус человека видят те, с кем у него общий чат или Звезда, и те, у кого он в контактах.
- Пропало последнее соединение — ждём OFFLINE_GRACE_SEC (перезагрузка страницы, короткий
  обрыв сети), потом объявляем «не в сети» и запоминаем время для «был(а) …».
- При каждом подключении человек получает сводку по всем, чей статус он видит.

Реестр в памяти: бэкенд работает одним процессом (как и ConnectionManager).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import WebSocket
from sqlalchemy import select, union, update

from app.core.database import AsyncSessionLocal
from app.models.chat import ChatMember
from app.models.contact import UserContact
from app.models.star import StarMember
from app.models.user import User
from app.ws.hub import manager

logger = logging.getLogger(__name__)

OFFLINE_GRACE_SEC = 8.0

# Подменяется в тестах, чтобы работать с тестовой схемой БД.
session_factory = AsyncSessionLocal

# Кому уже объявили «в сети».
_online: set[str] = set()
# Отложенное «не в сети» (ждём, не вернётся ли человек).
_going_offline: dict[str, asyncio.Task] = {}


def is_online(user_id: str) -> bool:
    return user_id in _online


def _co_members(user_id: str):
    my_chats = select(ChatMember.chat_id).where(ChatMember.user_id == user_id)
    my_stars = select(StarMember.star_id).where(StarMember.user_id == user_id)
    return (
        select(ChatMember.user_id.label("uid")).where(ChatMember.chat_id.in_(my_chats)),
        select(StarMember.user_id.label("uid")).where(StarMember.star_id.in_(my_stars)),
    )


async def audience(user_id: str) -> list[str]:
    """Кому показывать статус user_id."""
    async with session_factory() as db:
        rows = await db.execute(
            union(
                *_co_members(user_id),
                select(UserContact.owner_id.label("uid")).where(UserContact.contact_id == user_id),
            )
        )
        return [uid for (uid,) in rows if uid != user_id]


async def visible_to(user_id: str) -> list[dict]:
    """Статусы всех, кого видит user_id (сводка при подключении)."""
    async with session_factory() as db:
        peers = union(
            *_co_members(user_id),
            select(UserContact.contact_id.label("uid")).where(UserContact.owner_id == user_id),
        ).subquery()
        rows = await db.execute(
            select(User.id, User.last_seen_at).where(User.id.in_(select(peers.c.uid)), User.id != user_id)
        )
        return [_status(uid, last_seen) for uid, last_seen in rows]


def _status(user_id: str, last_seen: datetime | None) -> dict:
    online = is_online(user_id)
    return {
        "user_id": user_id,
        "online": online,
        "last_seen": None if online or not last_seen else last_seen.isoformat(),
    }


async def _announce(user_id: str, event: dict) -> None:
    try:
        await manager.broadcast_to_users(await audience(user_id), event)
    except Exception as exc:  # noqa: BLE001 — статус не должен ронять соединение
        logger.warning("presence broadcast for %s failed: %s", user_id, exc)


async def on_connect(user_id: str, websocket: WebSocket) -> None:
    pending = _going_offline.pop(user_id, None)
    if pending:
        pending.cancel()  # вернулся вовремя — для остальных он и не уходил
    if user_id not in _online:
        _online.add(user_id)
        await _announce(user_id, {"type": "presence", "user_id": user_id, "online": True, "last_seen": None})
    try:
        await manager.send(websocket, {"type": "presence_snapshot", "users": await visible_to(user_id)})
    except Exception as exc:  # noqa: BLE001
        logger.warning("presence snapshot for %s failed: %s", user_id, exc)


async def on_disconnect(user_id: str) -> None:
    if manager.user_connections.get(user_id) or user_id in _going_offline:
        return
    _going_offline[user_id] = asyncio.create_task(_go_offline_later(user_id))


async def _go_offline_later(user_id: str) -> None:
    try:
        await asyncio.sleep(OFFLINE_GRACE_SEC)
    except asyncio.CancelledError:
        return
    _going_offline.pop(user_id, None)
    if manager.user_connections.get(user_id):
        return
    _online.discard(user_id)
    now = datetime.now(timezone.utc)
    try:
        async with session_factory() as db:
            await db.execute(update(User).where(User.id == user_id).values(last_seen_at=now))
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("last_seen for %s failed: %s", user_id, exc)
    await _announce(
        user_id, {"type": "presence", "user_id": user_id, "online": False, "last_seen": now.isoformat()}
    )


def reset() -> None:
    """Для тестов."""
    for task in _going_offline.values():
        task.cancel()
    _going_offline.clear()
    _online.clear()

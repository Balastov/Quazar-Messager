"""Кто сейчас на какой Планете.

Источник правды — LiveKit: его вебхуки (participant_joined / participant_left / room_finished)
обновляют реестр в памяти, а при старте бэкенда реестр восстанавливается запросом к LiveKit.
Бэкенд работает одним процессом, поэтому реестра в памяти достаточно.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select

from app.core import livekit
from app.core.database import AsyncSessionLocal
from app.models.star import StarChannel, StarMember
from app.ws.hub import manager

logger = logging.getLogger(__name__)

ROOM_PREFIX = "planet-"

# Подменяется в тестах, чтобы работать с тестовой схемой БД.
session_factory = AsyncSessionLocal


def room_name(channel_id: str) -> str:
    return ROOM_PREFIX + channel_id


def channel_from_room(name: str | None) -> str | None:
    if not name or not name.startswith(ROOM_PREFIX):
        return None
    return name[len(ROOM_PREFIX) :] or None


@dataclass
class VoiceParticipant:
    user_id: str
    joined_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    # Модератор выключил микрофон (участник не может включить его сам).
    server_muted: bool = False

    def out(self) -> dict:
        return {
            "user_id": self.user_id,
            "joined_at": self.joined_at.isoformat(),
            "server_muted": self.server_muted,
        }


@dataclass
class Planet:
    star_id: str
    participants: dict[str, VoiceParticipant] = field(default_factory=dict)


# channel_id -> Planet
_planets: dict[str, Planet] = {}


def participants(channel_id: str) -> list[VoiceParticipant]:
    planet = _planets.get(channel_id)
    if not planet:
        return []
    return sorted(planet.participants.values(), key=lambda p: p.joined_at)


def star_presence(star_id: str) -> dict[str, list[dict]]:
    return {
        channel_id: [p.out() for p in participants(channel_id)]
        for channel_id, planet in _planets.items()
        if planet.star_id == star_id and planet.participants
    }


def channels_with_user(star_id: str, user_id: str) -> list[str]:
    return [
        channel_id
        for channel_id, planet in _planets.items()
        if planet.star_id == star_id and user_id in planet.participants
    ]


async def broadcast(star_id: str, channel_id: str) -> None:
    async with session_factory() as db:
        member_ids = [
            row[0]
            for row in (
                await db.execute(select(StarMember.user_id).where(StarMember.star_id == star_id))
            ).all()
        ]
    await manager.broadcast_to_users(
        member_ids,
        {
            "type": "star_voice",
            "star_id": star_id,
            "channel_id": channel_id,
            "participants": [p.out() for p in participants(channel_id)],
        },
    )


def _add(star_id: str, channel_id: str, user_id: str) -> None:
    planet = _planets.setdefault(channel_id, Planet(star_id=star_id))
    planet.participants.setdefault(user_id, VoiceParticipant(user_id=user_id))


def _remove(channel_id: str, user_id: str) -> bool:
    planet = _planets.get(channel_id)
    if not planet or user_id not in planet.participants:
        return False
    del planet.participants[user_id]
    if not planet.participants:
        _planets.pop(channel_id, None)
    return True


def set_server_muted(channel_id: str, user_id: str, muted: bool) -> bool:
    planet = _planets.get(channel_id)
    participant = planet.participants.get(user_id) if planet else None
    if not participant:
        return False
    participant.server_muted = muted
    return True


async def _planet_star(channel_id: str) -> str | None:
    async with session_factory() as db:
        return (
            await db.execute(
                select(StarChannel.star_id).where(
                    StarChannel.id == channel_id, StarChannel.kind == "planet"
                )
            )
        ).scalar_one_or_none()


async def handle_webhook(event: dict) -> None:
    kind = event.get("event")
    channel_id = channel_from_room((event.get("room") or {}).get("name"))
    if not channel_id:
        return

    if kind == "room_finished":
        planet = _planets.pop(channel_id, None)
        if planet:
            await broadcast(planet.star_id, channel_id)
        return

    identity = (event.get("participant") or {}).get("identity")
    if not identity:
        return

    if kind == "participant_joined":
        star_id = _planets[channel_id].star_id if channel_id in _planets else await _planet_star(channel_id)
        if not star_id:
            return
        _add(star_id, channel_id, identity)
        await broadcast(star_id, channel_id)
    elif kind in ("participant_left", "participant_connection_aborted"):
        planet = _planets.get(channel_id)
        if planet and _remove(channel_id, identity):
            await broadcast(planet.star_id, channel_id)


async def remove_from_planet(star_id: str, channel_id: str, user_id: str) -> None:
    """Вывести участника с Планеты (модерация)."""
    if livekit.configured():
        try:
            await livekit.room_service.remove_participant(room_name(channel_id), user_id)
        except livekit.LiveKitError as exc:
            logger.warning("remove %s from %s failed: %s", user_id, channel_id, exc)
    if _remove(channel_id, user_id):
        await broadcast(star_id, channel_id)


async def evict_user(star_id: str, user_id: str) -> None:
    """Выгнали или заблокировали — убираем со всех Планет этой Звезды."""
    for channel_id in channels_with_user(star_id, user_id):
        await remove_from_planet(star_id, channel_id, user_id)


async def close_planet(star_id: str, channel_id: str) -> None:
    """Планету удалили — закрываем комнату для всех."""
    had_people = _planets.pop(channel_id, None) is not None
    if livekit.configured():
        try:
            await livekit.room_service.delete_room(room_name(channel_id))
        except livekit.LiveKitError as exc:
            logger.warning("close planet %s failed: %s", channel_id, exc)
    if had_people:
        await broadcast(star_id, channel_id)


async def resync() -> None:
    """После перезапуска бэкенда восстанавливает реестр из LiveKit."""
    if not livekit.configured():
        return
    try:
        rooms = await livekit.room_service.list_rooms()
        for room in rooms:
            channel_id = channel_from_room(room.get("name"))
            if not channel_id:
                continue
            star_id = await _planet_star(channel_id)
            if not star_id:
                continue
            for p in await livekit.room_service.list_participants(room["name"]):
                identity = p.get("identity")
                if identity:
                    _add(star_id, channel_id, identity)
        logger.info("voice presence restored: %d planets", len(_planets))
    except Exception as exc:  # noqa: BLE001
        logger.warning("voice resync failed: %s", exc)


def reset() -> None:
    """Для тестов."""
    _planets.clear()

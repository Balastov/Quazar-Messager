"""Кто сейчас на какой Планете.

Источник правды — LiveKit: его вебхуки (participant_joined / participant_left / room_finished)
обновляют реестр в памяти, а при старте бэкенда реестр восстанавливается запросом к LiveKit.
Бэкенд работает одним процессом, поэтому реестра в памяти достаточно.

Показ экрана: на Планете его ведёт не больше одного человека. Токен разрешает публиковать
только микрофон; право на экран бэкенд выдаёт через UpdateParticipant тому, кто занял слот,
и отзывает, когда показ закончен (сам, модератором или ушёл с Планеты).

Главный в комнате: первый вошедший в пустую Планету. Ушёл — главным становится тот, кто
внутри дольше всех; главный может передать звание другому присутствующему. Права главного
действуют в комнатах «По приглашениям» (впускать, звать) — см. app/api/doors.py.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select

from app.core import doors, livekit
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
    # Занял слот показа экрана на этой Планете.
    screen_sharing: bool = False
    # sid опубликованного трека экрана (из вебхука): по нему узнаём, что показ закончился.
    screen_track_sid: str | None = None

    def out(self) -> dict:
        return {
            "user_id": self.user_id,
            "joined_at": self.joined_at.isoformat(),
            "server_muted": self.server_muted,
            "screen_sharing": self.screen_sharing,
        }

    def publish_sources(self, listen_only: bool = False) -> list[str]:
        sources = [] if self.server_muted or listen_only else [livekit.SOURCE_MICROPHONE]
        if self.screen_sharing:
            sources += [livekit.SOURCE_SCREEN_SHARE, livekit.SOURCE_SCREEN_SHARE_AUDIO]
        return sources


class ScreenBusy(Exception):
    """Экран на этой Планете уже показывает другой участник."""

    def __init__(self, user_id: str):
        super().__init__(user_id)
        self.user_id = user_id


@dataclass
class Planet:
    star_id: str
    # «Только слушать»: микрофоны запрещены всем.
    listen_only: bool = False
    participants: dict[str, VoiceParticipant] = field(default_factory=dict)
    host_id: str | None = None


# channel_id -> Planet
_planets: dict[str, Planet] = {}


def participants(channel_id: str) -> list[VoiceParticipant]:
    planet = _planets.get(channel_id)
    if not planet:
        return []
    return sorted(planet.participants.values(), key=lambda p: p.joined_at)


def host(channel_id: str) -> str | None:
    planet = _planets.get(channel_id)
    return planet.host_id if planet else None


def presence(channel_id: str) -> list[dict]:
    host_id = host(channel_id)
    return [{**p.out(), "is_host": p.user_id == host_id} for p in participants(channel_id)]


def star_presence(star_id: str) -> dict[str, list[dict]]:
    return {
        channel_id: presence(channel_id)
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
            "participants": presence(channel_id),
        },
    )


def _add(star_id: str, channel_id: str, user_id: str, listen_only: bool = False) -> None:
    planet = _planets.setdefault(channel_id, Planet(star_id=star_id, listen_only=listen_only))
    planet.participants.setdefault(user_id, VoiceParticipant(user_id=user_id))
    if planet.host_id not in planet.participants:
        planet.host_id = user_id


def _remove(channel_id: str, user_id: str) -> bool:
    planet = _planets.get(channel_id)
    if not planet or user_id not in planet.participants:
        return False
    del planet.participants[user_id]
    if not planet.participants:
        _planets.pop(channel_id, None)
    elif planet.host_id == user_id:
        planet.host_id = participants(channel_id)[0].user_id
    return True


async def set_host(star_id: str, channel_id: str, user_id: str) -> bool:
    """Передать звание главного другому присутствующему."""
    planet = _planets.get(channel_id)
    if not planet or user_id not in planet.participants:
        return False
    planet.host_id = user_id
    await broadcast(star_id, channel_id)
    return True


async def _after_leave(star_id: str, channel_id: str, user_id: str | None) -> None:
    """Зал ожидания, стуки и новый главный (импорт здесь: иначе цикл модулей)."""
    from app.api.doors import on_participant_left

    async with session_factory() as db:
        await on_participant_left(db, star_id, channel_id, user_id)


def _participant(channel_id: str, user_id: str) -> VoiceParticipant | None:
    planet = _planets.get(channel_id)
    return planet.participants.get(user_id) if planet else None


def screen_sharer(channel_id: str) -> VoiceParticipant | None:
    return next((p for p in participants(channel_id) if p.screen_sharing), None)


async def _apply_permissions(channel_id: str, participant: VoiceParticipant) -> None:
    planet = _planets.get(channel_id)
    await livekit.room_service.update_publish_sources(
        room_name(channel_id),
        participant.user_id,
        participant.publish_sources(listen_only=bool(planet and planet.listen_only)),
    )


async def set_listen_only(star_id: str, channel_id: str, listen_only: bool) -> None:
    """Режим Планеты поменяли — права на микрофон у всех, кто внутри, меняются сразу."""
    planet = _planets.get(channel_id)
    if not planet:
        return
    planet.listen_only = listen_only
    for participant in list(planet.participants.values()):
        try:
            await _apply_permissions(channel_id, participant)
        except livekit.LiveKitError as exc:
            logger.warning("listen-only %s on %s failed: %s", participant.user_id, channel_id, exc)


async def set_server_muted(star_id: str, channel_id: str, user_id: str, muted: bool) -> bool:
    """Модератор выключил или вернул микрофон. Показ экрана это не трогает."""
    participant = _participant(channel_id, user_id)
    if not participant:
        return False
    previous = participant.server_muted
    participant.server_muted = muted
    try:
        await _apply_permissions(channel_id, participant)
    except livekit.LiveKitError:
        participant.server_muted = previous
        raise
    await broadcast(star_id, channel_id)
    return True


async def start_screen(star_id: str, channel_id: str, user_id: str) -> bool:
    """Занять слот показа экрана. False — участника нет на Планете; ScreenBusy — слот занят."""
    participant = _participant(channel_id, user_id)
    if not participant:
        return False
    if participant.screen_sharing:
        return True
    current = screen_sharer(channel_id)
    if current:
        raise ScreenBusy(current.user_id)
    # Слот занимаем до первого await: два одновременных запроса не пройдут оба.
    participant.screen_sharing = True
    participant.screen_track_sid = None
    try:
        await _apply_permissions(channel_id, participant)
    except livekit.LiveKitError:
        participant.screen_sharing = False
        raise
    await broadcast(star_id, channel_id)
    return True


async def stop_screen(star_id: str, channel_id: str, user_id: str) -> bool:
    """Закончить показ: отзываем право — LiveKit сам снимает трек экрана у всех."""
    participant = _participant(channel_id, user_id)
    if not participant or not participant.screen_sharing:
        return False
    participant.screen_sharing = False
    participant.screen_track_sid = None
    try:
        await _apply_permissions(channel_id, participant)
    except livekit.LiveKitError as exc:
        # Клиенты всё равно показывают только того, у кого есть слот; ушедший трек
        # освободится вместе с участником.
        logger.warning("revoke screen of %s on %s failed: %s", user_id, channel_id, exc)
    await broadcast(star_id, channel_id)
    return True


async def _on_track(kind: str, channel_id: str, identity: str, track: dict) -> None:
    if livekit.track_source(track.get("source")) != livekit.SOURCE_SCREEN_SHARE:
        return
    planet = _planets.get(channel_id)
    participant = planet.participants.get(identity) if planet else None
    if not participant or not participant.screen_sharing:
        return
    sid = track.get("sid")
    if kind == "track_published":
        participant.screen_track_sid = sid
    elif sid and sid == participant.screen_track_sid:
        # Нажали «Остановить показ» в браузере, а клиент не успел сказать бэкенду.
        await stop_screen(planet.star_id, channel_id, identity)


async def _planet_info(channel_id: str) -> tuple[str, bool] | None:
    """Звезда Планеты и режим «Только слушать»."""
    async with session_factory() as db:
        row = (
            await db.execute(
                select(StarChannel.star_id, StarChannel.listen_only).where(
                    StarChannel.id == channel_id, StarChannel.kind == "planet"
                )
            )
        ).first()
    return (row[0], bool(row[1])) if row else None


async def handle_webhook(event: dict) -> None:
    kind = event.get("event")
    channel_id = channel_from_room((event.get("room") or {}).get("name"))
    if not channel_id:
        return

    if kind == "room_finished":
        planet = _planets.pop(channel_id, None)
        if planet:
            await broadcast(planet.star_id, channel_id)
            await _after_leave(planet.star_id, channel_id, None)
        return

    identity = (event.get("participant") or {}).get("identity")
    if not identity:
        return

    if kind in ("track_published", "track_unpublished"):
        await _on_track(kind, channel_id, identity, event.get("track") or {})
    elif kind == "participant_joined":
        planet = _planets.get(channel_id)
        info = (planet.star_id, planet.listen_only) if planet else await _planet_info(channel_id)
        if not info:
            return
        star_id, listen_only = info
        _add(star_id, channel_id, identity, listen_only)
        doors.consume_pass(identity, channel_id)
        if listen_only:
            # Токен выдали до того, как Планету сделали «Только слушать», — забираем микрофон.
            try:
                await _apply_permissions(channel_id, _planets[channel_id].participants[identity])
            except livekit.LiveKitError as exc:
                logger.warning("listen-only %s on %s failed: %s", identity, channel_id, exc)
        await broadcast(star_id, channel_id)
    elif kind in ("participant_left", "participant_connection_aborted"):
        planet = _planets.get(channel_id)
        if planet and _remove(channel_id, identity):
            await broadcast(planet.star_id, channel_id)
            await _after_leave(planet.star_id, channel_id, identity)


async def remove_from_planet(star_id: str, channel_id: str, user_id: str) -> None:
    """Вывести участника с Планеты (модерация)."""
    if livekit.configured():
        try:
            await livekit.room_service.remove_participant(room_name(channel_id), user_id)
        except livekit.LiveKitError as exc:
            logger.warning("remove %s from %s failed: %s", user_id, channel_id, exc)
    if _remove(channel_id, user_id):
        await broadcast(star_id, channel_id)
        await _after_leave(star_id, channel_id, user_id)


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
            info = await _planet_info(channel_id)
            if not info:
                continue
            star_id, listen_only = info
            for p in await livekit.room_service.list_participants(room["name"]):
                identity = p.get("identity")
                if not identity:
                    continue
                _add(star_id, channel_id, identity, listen_only)
                screen = next(
                    (
                        t
                        for t in p.get("tracks") or []
                        if livekit.track_source(t.get("source")) == livekit.SOURCE_SCREEN_SHARE
                    ),
                    None,
                )
                if screen and not screen_sharer(channel_id):
                    restored = _planets[channel_id].participants[identity]
                    restored.screen_sharing = True
                    restored.screen_track_sid = screen.get("sid")
        logger.info("voice presence restored: %d planets", len(_planets))
    except Exception as exc:  # noqa: BLE001
        logger.warning("voice resync failed: %s", exc)


def reset() -> None:
    """Для тестов."""
    _planets.clear()

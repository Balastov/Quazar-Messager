"""Кто сейчас на какой Планете.

Источник правды — LiveKit: его вебхуки (participant_joined / participant_left / room_finished)
обновляют реестр в памяти, а при старте бэкенда реестр восстанавливается запросом к LiveKit.
Бэкенд работает одним процессом, поэтому реестра в памяти достаточно.

Показ экрана: на игровой Планете его ведёт не больше одного человека, в Комнате рабочей Звезды —
до двух одновременно. Токен разрешает публиковать только микрофон; право на экран бэкенд выдаёт
через UpdateParticipant тому, кто занял слот, и отзывает, когда показ закончен (сам, модератором
или ушёл с Планеты).

Время активности: Планета «идёт» с входа первого человека в пустую комнату до выхода последнего.
Начало пишем и в метаданные комнаты LiveKit — после перезапуска бэкенда счётчик не сбрасывается.

Главный в комнате: первый вошедший в пустую Планету. Ушёл — главным становится тот, кто
внутри дольше всех; главный может передать звание другому присутствующему. Права главного
действуют в комнатах «По приглашениям» (впускать, звать) — см. app/api/doors.py.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select

from app.core import doors, floors, livekit
from app.core.database import AsyncSessionLocal
from app.models.star import StarChannel, StarMember
from app.ws.hub import manager

logger = logging.getLogger(__name__)

ROOM_PREFIX = "planet-"
# Гости по ссылке (без аккаунта): identity = guest-<id ссылки>-<случайное>.
GUEST_PREFIX = "guest-"


def is_guest(identity: str | None) -> bool:
    return bool(identity) and identity.startswith(GUEST_PREFIX)

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
    # Занял место камеры (их в комнате не больше MAX_CAMERAS); по умолчанию камера выключена.
    camera: bool = False
    camera_track_sid: str | None = None
    # Модератор выключил камеру: включить её снова человек не может, пока не разрешат.
    camera_blocked: bool = False
    # Ведёт запись встречи (app/core/recordings.py): все в комнате видят «Идёт запись».
    recording: bool = False
    # С какого момента идёт запись: все видят, сколько она уже длится.
    recording_since: datetime | None = None
    # Имя гостя по ссылке (у участников Звезды имя берут из списка участников).
    guest_name: str | None = None
    # Имя в Звезде и фото из токена: по ним посетителя по ссылке видят участники, а он — их.
    name: str | None = None
    avatar_url: str | None = None
    # Открыл гостевую ссылку под своим аккаунтом, не будучи участником Звезды.
    visitor: bool = False

    def out(self) -> dict:
        return {
            "user_id": self.user_id,
            "joined_at": self.joined_at.isoformat(),
            "server_muted": self.server_muted,
            "screen_sharing": self.screen_sharing,
            "camera": self.camera,
            "camera_blocked": self.camera_blocked,
            "recording": self.recording,
            "recording_since": self.recording_since.isoformat() if self.recording_since else None,
            "guest_name": self.guest_name,
            "name": self.name,
            "avatar_url": self.avatar_url,
            "visitor": self.visitor,
        }

    def publish_sources(self, listen_only: bool = False) -> list[str]:
        sources = [] if self.server_muted or listen_only else [livekit.SOURCE_MICROPHONE]
        if self.screen_sharing:
            sources += [livekit.SOURCE_SCREEN_SHARE, livekit.SOURCE_SCREEN_SHARE_AUDIO]
        # Камера — как голос: в «Только слушать» её нет.
        if self.camera and not self.camera_blocked and not listen_only:
            sources.append(livekit.SOURCE_CAMERA)
        return sources


# Сколько человек одновременно показывают экран: рабочая Комната — двое, игровая Планета — один.
MAX_SCREENS = 2


def screen_limit(star_kind: str) -> int:
    return MAX_SCREENS if star_kind == "work" else 1


# Сколько камер одновременно в одной комнате: каждая уходит всем остальным (до 25 человек),
# а сервер один — сетка 3×3.
MAX_CAMERAS = 9


class CameraBusy(Exception):
    """Все места камер в комнате заняты."""


class CameraBlocked(Exception):
    """Камеру выключил модератор, либо комната в режиме «Только слушать»."""


class ScreenBusy(Exception):
    """Все слоты показа экрана на этой Планете заняты."""

    def __init__(self, user_ids: list[str]):
        super().__init__(*user_ids)
        self.user_ids = user_ids


@dataclass
class Planet:
    star_id: str
    # «Только слушать»: микрофоны запрещены всем.
    listen_only: bool = False
    participants: dict[str, VoiceParticipant] = field(default_factory=dict)
    host_id: str | None = None
    # Когда в пустую Планету вошёл первый человек.
    active_since: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


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


def active_since(channel_id: str) -> datetime | None:
    planet = _planets.get(channel_id)
    return planet.active_since if planet else None


def star_active_since(star_id: str) -> dict[str, str]:
    """channel_id -> когда на Планете появился первый из тех, кто там сейчас (без перерыва)."""
    return {
        channel_id: planet.active_since.isoformat()
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
        # Кто сидит в комнате закрытого этажа, видят только те, у кого к нему есть доступ
        # (и посетители по гостевой ссылке в эту комнату).
        audience = await floors.room_audience(db, channel_id)
        if audience is not None:
            member_ids = list(audience)
    await manager.broadcast_to_users(
        member_ids,
        {
            "type": "star_voice",
            "star_id": star_id,
            "channel_id": channel_id,
            "participants": presence(channel_id),
            "active_since": since.isoformat() if (since := active_since(channel_id)) else None,
        },
    )


def _metadata(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _add(
    star_id: str, channel_id: str, user_id: str, listen_only: bool = False, name: str | None = None, metadata=None
) -> None:
    planet = _planets.setdefault(channel_id, Planet(star_id=star_id, listen_only=listen_only))
    participant = planet.participants.setdefault(user_id, VoiceParticipant(user_id=user_id))
    if is_guest(user_id):
        participant.guest_name = (name or "Гость")[:60]
        return
    meta = _metadata(metadata)
    participant.name = (name or "")[:80] or None
    avatar = meta.get("avatar_url")
    participant.avatar_url = avatar if isinstance(avatar, str) else None
    participant.visitor = meta.get("visitor") is True
    # Главным может быть только участник Звезды — не гость и не посетитель по ссылке.
    if not participant.visitor and planet.host_id not in planet.participants:
        planet.host_id = user_id


def _remove(channel_id: str, user_id: str) -> bool:
    planet = _planets.get(channel_id)
    if not planet or user_id not in planet.participants:
        return False
    del planet.participants[user_id]
    if not planet.participants:
        _planets.pop(channel_id, None)
    elif planet.host_id == user_id:
        members = [p.user_id for p in participants(channel_id) if not is_guest(p.user_id) and not p.visitor]
        planet.host_id = members[0] if members else None
    return True


async def set_host(star_id: str, channel_id: str, user_id: str) -> bool:
    """Передать звание главного другому присутствующему (не гостю)."""
    planet = _planets.get(channel_id)
    if not planet or user_id not in planet.participants or is_guest(user_id) or planet.participants[user_id].visitor:
        return False
    planet.host_id = user_id
    await broadcast(star_id, channel_id)
    return True


async def _after_leave(star_id: str, channel_id: str, user_id: str | None) -> None:
    """Зал ожидания, стуки и новый главный (импорт здесь: иначе цикл модулей)."""
    from app.api.doors import on_participant_left
    from app.core import recordings

    async with session_factory() as db:
        await on_participant_left(db, star_id, channel_id, user_id)
        # Включивший запись вышел — запись завершается тем, что успело прийти.
        await recordings.on_participant_left(db, channel_id, user_id)


def _participant(channel_id: str, user_id: str) -> VoiceParticipant | None:
    planet = _planets.get(channel_id)
    return planet.participants.get(user_id) if planet else None


def screen_sharers(channel_id: str) -> list[VoiceParticipant]:
    """Кто сейчас показывает экран — в порядке входа в комнату."""
    return [p for p in participants(channel_id) if p.screen_sharing]


def is_screen_sharer(channel_id: str, user_id: str | None) -> bool:
    return any(p.user_id == user_id for p in screen_sharers(channel_id))


async def set_recording(star_id: str, channel_id: str, user_id: str, on: bool) -> bool:
    """«Идёт запись» у этого человека в комнате. False — его нет внутри или ничего не поменялось."""
    participant = _participant(channel_id, user_id)
    if not participant or participant.recording == on:
        if not participant and not on:
            await _remember_start(channel_id)  # включивший уже вышел — снять отметку у гостей
        return False
    participant.recording = on
    participant.recording_since = datetime.now(timezone.utc) if on else None
    await broadcast(star_id, channel_id)
    await _remember_start(channel_id)
    return True


def cameras(channel_id: str) -> list[VoiceParticipant]:
    """У кого сейчас включена камера."""
    return [p for p in participants(channel_id) if p.camera]


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
    had_cameras = bool(cameras(channel_id))
    for participant in list(planet.participants.values()):
        if listen_only:
            # Камеры гаснут вместе с микрофонами; место освобождаем.
            participant.camera = False
            participant.camera_track_sid = None
        try:
            await _apply_permissions(channel_id, participant)
        except livekit.LiveKitError as exc:
            logger.warning("listen-only %s on %s failed: %s", participant.user_id, channel_id, exc)
    if listen_only and had_cameras:
        await broadcast(star_id, channel_id)


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


async def start_screen(star_id: str, channel_id: str, user_id: str, limit: int = 1) -> bool:
    """Занять слот показа экрана. False — участника нет на Планете; ScreenBusy — слоты заняты."""
    participant = _participant(channel_id, user_id)
    if not participant:
        return False
    if participant.screen_sharing:
        return True
    current = screen_sharers(channel_id)
    if len(current) >= limit:
        raise ScreenBusy([p.user_id for p in current])
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


async def start_camera(star_id: str, channel_id: str, user_id: str) -> bool:
    """Занять место камеры. False — человека нет в комнате; CameraBusy — мест нет."""
    planet = _planets.get(channel_id)
    participant = planet.participants.get(user_id) if planet else None
    if not participant:
        return False
    if participant.camera_blocked or planet.listen_only:
        raise CameraBlocked()
    if participant.camera:
        return True
    if len(cameras(channel_id)) >= MAX_CAMERAS:
        raise CameraBusy()
    # Место занимаем до первого await: два одновременных запроса не пройдут оба.
    participant.camera = True
    participant.camera_track_sid = None
    try:
        await _apply_permissions(channel_id, participant)
    except livekit.LiveKitError:
        participant.camera = False
        raise
    await broadcast(star_id, channel_id)
    return True


async def stop_camera(star_id: str, channel_id: str, user_id: str) -> bool:
    """Выключить камеру: отзываем право — LiveKit сам снимает трек у всех."""
    participant = _participant(channel_id, user_id)
    if not participant or not participant.camera:
        return False
    participant.camera = False
    participant.camera_track_sid = None
    try:
        await _apply_permissions(channel_id, participant)
    except livekit.LiveKitError as exc:
        logger.warning("revoke camera of %s on %s failed: %s", user_id, channel_id, exc)
    await broadcast(star_id, channel_id)
    return True


async def set_camera_blocked(star_id: str, channel_id: str, user_id: str, blocked: bool) -> bool:
    """Модератор выключил камеру и не даёт включить её снова — или разрешил."""
    participant = _participant(channel_id, user_id)
    if not participant:
        return False
    previous = (participant.camera_blocked, participant.camera, participant.camera_track_sid)
    participant.camera_blocked = blocked
    if blocked:
        participant.camera = False
        participant.camera_track_sid = None
    try:
        await _apply_permissions(channel_id, participant)
    except livekit.LiveKitError:
        participant.camera_blocked, participant.camera, participant.camera_track_sid = previous
        raise
    await broadcast(star_id, channel_id)
    return True


async def _on_camera_track(kind: str, channel_id: str, identity: str, track: dict) -> None:
    planet = _planets.get(channel_id)
    participant = planet.participants.get(identity) if planet else None
    if not participant or not participant.camera:
        return
    sid = track.get("sid")
    if kind == "track_published":
        participant.camera_track_sid = sid
    elif sid and sid == participant.camera_track_sid:
        # Камеру сняли с публикации, а клиент не успел сказать бэкенду (закрыли вкладку и т.п.).
        await stop_camera(planet.star_id, channel_id, identity)


async def _on_track(kind: str, channel_id: str, identity: str, track: dict) -> None:
    source = livekit.track_source(track.get("source"))
    if source == livekit.SOURCE_CAMERA:
        await _on_camera_track(kind, channel_id, identity, track)
        return
    if source != livekit.SOURCE_SCREEN_SHARE:
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
        started = planet is None
        participant = event.get("participant") or {}
        _add(star_id, channel_id, identity, listen_only, participant.get("name"), participant.get("metadata"))
        doors.consume_pass(identity, channel_id)
        if listen_only:
            # Токен выдали до того, как Планету сделали «Только слушать», — забираем микрофон.
            try:
                await _apply_permissions(channel_id, _planets[channel_id].participants[identity])
            except livekit.LiveKitError as exc:
                logger.warning("listen-only %s on %s failed: %s", identity, channel_id, exc)
        await broadcast(star_id, channel_id)
        if started:
            await _remember_start(channel_id)
    elif kind in ("participant_left", "participant_connection_aborted"):
        planet = _planets.get(channel_id)
        if planet and _remove(channel_id, identity):
            await broadcast(planet.star_id, channel_id)
            await _after_leave(planet.star_id, channel_id, identity)


async def _remember_start(channel_id: str) -> None:
    """Метаданные комнаты в LiveKit: с какого времени она активна (переживает перезапуск бэкенда)
    и идёт ли запись — её видят и гости по ссылке, у которых нет присутствия Звезды."""
    planet = _planets.get(channel_id)
    if not planet:
        return
    meta: dict = {"active_since": planet.active_since.isoformat()}
    recorder = next((p for p in planet.participants.values() if p.recording), None)
    if recorder:
        # Гости видят, кто записывает (по identity находят имя участника) и сколько идёт запись.
        meta["recording"] = True
        meta["recording_by"] = recorder.user_id
        if recorder.recording_since:
            meta["recording_since"] = recorder.recording_since.isoformat()
    try:
        await livekit.room_service.update_room_metadata(room_name(channel_id), json.dumps(meta))
    except livekit.LiveKitError as exc:
        logger.warning("room metadata of %s failed: %s", channel_id, exc)


def _from_epoch(value) -> datetime | None:
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(seconds, timezone.utc) if seconds > 0 else None


def _restored_start(room: dict, planet: Planet) -> datetime:
    """Начало активности из метаданных комнаты; нет их — когда вошёл самый ранний из присутствующих."""
    try:
        since = datetime.fromisoformat(json.loads(room.get("metadata") or "{}")["active_since"])
        if since.tzinfo is not None:
            return since
    except (ValueError, KeyError, TypeError):
        pass
    return min((p.joined_at for p in planet.participants.values()), default=planet.active_since)


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
                _add(star_id, channel_id, identity, listen_only, p.get("name"), p.get("metadata"))
                joined = _from_epoch(livekit.field(p, "joined_at"))
                if joined:
                    _planets[channel_id].participants[identity].joined_at = joined
                screen = next(
                    (
                        t
                        for t in p.get("tracks") or []
                        if livekit.track_source(t.get("source")) == livekit.SOURCE_SCREEN_SHARE
                    ),
                    None,
                )
                if screen and len(screen_sharers(channel_id)) < MAX_SCREENS:
                    restored = _planets[channel_id].participants[identity]
                    restored.screen_sharing = True
                    restored.screen_track_sid = screen.get("sid")
                camera = next(
                    (t for t in p.get("tracks") or [] if livekit.track_source(t.get("source")) == livekit.SOURCE_CAMERA),
                    None,
                )
                if camera and len(cameras(channel_id)) < MAX_CAMERAS:
                    restored = _planets[channel_id].participants[identity]
                    restored.camera = True
                    restored.camera_track_sid = camera.get("sid")
            if channel_id in _planets:
                _planets[channel_id].active_since = _restored_start(room, _planets[channel_id])
        logger.info("voice presence restored: %d planets", len(_planets))
    except Exception as exc:  # noqa: BLE001
        logger.warning("voice resync failed: %s", exc)


def reset() -> None:
    """Для тестов."""
    _planets.clear()

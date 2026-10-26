"""Кто в сети: «в сети», «отошёл(ла)» или «был(а) …».

- online — хотя бы одно устройство активно (с ним работают прямо сейчас);
- away — соединения есть, но все неактивны: на ПК давно не трогали мышь и клавиатуру,
  на телефоне приложение свёрнуто или экран погас. Активность определяет клиент и
  сообщает серверу (?state=… при подключении и событие activity);
- offline — соединений нет. Пропало последнее — ждём OFFLINE_GRACE_SEC (перезагрузка
  страницы, короткий обрыв сети), потом объявляем и запоминаем время для «был(а) …».

Ручной статус («на встрече», «не беспокоить», с таймером) хранится в users и показывается
поверх online/away/offline; истёкший клиенты не показывают сами (until в событии).
Свой статус (значок, текст, «до») — отдельно от ручного и ни на что не влияет: только подпись.

Статус человека видят те, с кем у него общий чат или Звезда, и те, у кого он в контактах.
При каждом подключении человек получает сводку по всем, чей статус он видит (и свой).
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
ONLINE, AWAY, OFFLINE = "online", "away", "offline"
MANUAL_KINDS = ("meeting", "dnd")

# Подменяется в тестах, чтобы работать с тестовой схемой БД.
session_factory = AsyncSessionLocal

# Что уже объявлено о человеке: online | away (offline — нет в словаре).
_announced: dict[str, str] = {}
# С какого момента «отошёл(ла)».
_away_since: dict[str, datetime] = {}
# Активно ли соединение (websocket → True/False).
_active: dict[WebSocket, bool] = {}
# Отложенное «не в сети» (ждём, не вернётся ли человек).
_going_offline: dict[str, asyncio.Task] = {}
# Ручной статус тех, кто подключён: user_id → (kind, until).
_manual: dict[str, tuple[str, datetime | None]] = {}
# Свой статус тех, кто подключён: user_id → {"icon", "text", "until"}.
_custom: dict[str, dict] = {}


def _manual_out(kind: str | None, until: datetime | None) -> dict | None:
    if kind not in MANUAL_KINDS or (until and until <= datetime.now(timezone.utc)):
        return None
    return {"kind": kind, "until": until.isoformat() if until else None}


def _custom_out(raw: dict | None) -> dict | None:
    """Свой статус, если он ещё действует."""
    if not isinstance(raw, dict) or not (raw.get("icon") or raw.get("text")):
        return None
    until = raw.get("until")
    if until:
        try:
            if datetime.fromisoformat(until) <= datetime.now(timezone.utc):
                return None
        except (TypeError, ValueError):
            return None
    return {"icon": raw.get("icon"), "text": raw.get("text") or "", "until": until}


def status_of(user_id: str) -> str:
    return _announced.get(user_id, OFFLINE)


def is_online(user_id: str) -> bool:
    """Есть хоть одно соединение (в сети или отошёл)."""
    return user_id in _announced


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
            select(User.id, User.last_seen_at, User.manual_status, User.manual_status_until, User.custom_status).where(
                # Себя — тоже: так все устройства знают ваш ручной статус.
                (User.id.in_(select(peers.c.uid))) | (User.id == user_id)
            )
        )
        return [
            _status_event(uid, last_seen, _manual_out(kind, until), _custom_out(custom))
            for uid, last_seen, kind, until, custom in rows
        ]


def _status_event(
    user_id: str, last_seen: datetime | None, manual: dict | None = None, custom: dict | None = None
) -> dict:
    status = status_of(user_id)
    away_since = _away_since.get(user_id) if status == AWAY else None
    if manual is None and user_id in _manual:
        manual = _manual_out(*_manual[user_id])
    if custom is None and user_id in _custom:
        custom = _custom_out(_custom[user_id])
    return {
        "user_id": user_id,
        "status": status,
        # Для старых клиентов: «в сети» — есть соединение.
        "online": status != OFFLINE,
        "away_since": away_since.isoformat() if away_since else None,
        "last_seen": last_seen.isoformat() if status == OFFLINE and last_seen else None,
        "manual": manual,
        "custom": custom,
    }


def _connected_status(user_id: str) -> str:
    sockets = manager.user_connections.get(user_id, [])
    return ONLINE if any(_active.get(ws, True) for ws in sockets) else AWAY


async def _announce(user_id: str, event: dict) -> None:
    try:
        await manager.broadcast_to_users(await audience(user_id), {"type": "presence", **event})
    except Exception as exc:  # noqa: BLE001 — статус не должен ронять соединение
        logger.warning("presence broadcast for %s failed: %s", user_id, exc)


async def _refresh(user_id: str) -> None:
    """Пересчитать online/away по всем соединениям и разослать, если изменилось."""
    status = _connected_status(user_id)
    if _announced.get(user_id) == status:
        return
    _announced[user_id] = status
    if status == AWAY:
        _away_since[user_id] = datetime.now(timezone.utc)
    else:
        _away_since.pop(user_id, None)
    await _announce(user_id, _status_event(user_id, None))


async def _load_manual(user_id: str) -> None:
    async with session_factory() as db:
        row = (
            await db.execute(
                select(User.manual_status, User.manual_status_until, User.custom_status).where(User.id == user_id)
            )
        ).first()
    if row and row[0]:
        _manual[user_id] = (row[0], row[1])
    else:
        _manual.pop(user_id, None)
    if row and row[2]:
        _custom[user_id] = row[2]
    else:
        _custom.pop(user_id, None)


async def set_manual(user_id: str, kind: str | None, until: datetime | None) -> dict | None:
    """«На встрече» / «Не беспокоить» до until (или пока не снимут); kind=None — снять."""
    async with session_factory() as db:
        await db.execute(
            update(User)
            .where(User.id == user_id)
            .values(manual_status=kind, manual_status_until=until if kind else None)
        )
        await db.commit()
    if kind:
        _manual[user_id] = (kind, until)
    else:
        _manual.pop(user_id, None)
    manual = _manual_out(kind, until)
    event = {"type": "presence", **_status_event(user_id, None, manual)}
    if event["status"] == OFFLINE:
        async with session_factory() as db:
            last_seen = (
                await db.execute(select(User.last_seen_at).where(User.id == user_id))
            ).scalar_one_or_none()
        event["last_seen"] = last_seen.isoformat() if last_seen else None
    try:
        await manager.broadcast_to_users([*await audience(user_id), user_id], event)
    except Exception as exc:  # noqa: BLE001
        logger.warning("manual status broadcast for %s failed: %s", user_id, exc)
    return manual


async def set_custom(user_id: str, value: dict | None) -> dict | None:
    """Свой статус {icon, text, until} или None — снять. Разослать всем, кто видит человека."""
    async with session_factory() as db:
        await db.execute(update(User).where(User.id == user_id).values(custom_status=value))
        await db.commit()
        last_seen = (await db.execute(select(User.last_seen_at).where(User.id == user_id))).scalar_one_or_none()
    if value:
        _custom[user_id] = value
    else:
        _custom.pop(user_id, None)
    event = {"type": "presence", **_status_event(user_id, last_seen, custom=_custom_out(value))}
    try:
        await manager.broadcast_to_users([*await audience(user_id), user_id], event)
    except Exception as exc:  # noqa: BLE001
        logger.warning("custom status broadcast for %s failed: %s", user_id, exc)
    return _custom_out(value)


async def do_not_disturb(user_id: str) -> bool:
    """Включено ли «Не беспокоить» (для push-уведомлений). Не смогли узнать — считаем, что нет."""
    try:
        async with session_factory() as db:
            row = (
                await db.execute(
                    select(User.manual_status, User.manual_status_until).where(User.id == user_id)
                )
            ).first()
    except Exception as exc:  # noqa: BLE001 — уведомление важнее
        logger.warning("dnd check for %s failed: %s", user_id, exc)
        return False
    manual = _manual_out(*row) if row else None
    return bool(manual and manual["kind"] == "dnd")


async def on_connect(user_id: str, websocket: WebSocket, active: bool = True) -> None:
    _active[websocket] = active
    if user_id not in _manual:
        try:
            await _load_manual(user_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("manual status for %s failed: %s", user_id, exc)
    pending = _going_offline.pop(user_id, None)
    if pending:
        pending.cancel()  # вернулся вовремя — для остальных он и не уходил
    await _refresh(user_id)
    try:
        await manager.send(websocket, {"type": "presence_snapshot", "users": await visible_to(user_id)})
    except Exception as exc:  # noqa: BLE001
        logger.warning("presence snapshot for %s failed: %s", user_id, exc)


async def on_activity(user_id: str, websocket: WebSocket, active: bool) -> None:
    """Клиент сообщил: с ним работают (active) или нет (idle)."""
    if _active.get(websocket) == active:
        return
    _active[websocket] = active
    if user_id in _announced:
        await _refresh(user_id)


async def on_disconnect(user_id: str, websocket: WebSocket | None = None) -> None:
    if websocket is not None:
        _active.pop(websocket, None)
    if manager.user_connections.get(user_id):
        # Ушло, например, активное устройство, а свёрнутый телефон остался — «отошёл».
        await _refresh(user_id)
        return
    if user_id in _going_offline:
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
    _announced.pop(user_id, None)
    _away_since.pop(user_id, None)
    now = datetime.now(timezone.utc)
    try:
        async with session_factory() as db:
            await db.execute(update(User).where(User.id == user_id).values(last_seen_at=now))
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("last_seen for %s failed: %s", user_id, exc)
    await _announce(user_id, _status_event(user_id, now))
    _manual.pop(user_id, None)
    _custom.pop(user_id, None)


def reset() -> None:
    """Для тестов."""
    for task in _going_offline.values():
        task.cancel()
    _going_offline.clear()
    _announced.clear()
    _away_since.clear()
    _active.clear()
    _manual.clear()
    _custom.clear()

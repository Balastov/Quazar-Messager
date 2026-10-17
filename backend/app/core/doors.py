"""Двери комнат «По приглашениям»: пропуска и стуки.

- Пропуск — разовое разрешение войти в комнату (после «Впустить» или «Позвать»), живёт пару минут.
- Стук — просьба впустить: ждёт ответа (pending) или человек отправлен в зал ожидания (waiting).

Хранится в памяти: бэкенд работает одним процессом, а всё это короткоживущее.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

PASS_TTL_SEC = 120
INVITE_TTL_SEC = 300
KNOCK_TTL_SEC = 120
WAITING_TTL_SEC = 60 * 60


def _now() -> float:
    return time.monotonic()


@dataclass
class Knock:
    star_id: str
    channel_id: str
    user_id: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "pending"  # pending | waiting
    created_at: float = field(default_factory=_now)
    expires_at: float = field(default_factory=lambda: _now() + KNOCK_TTL_SEC)
    # Зал ожидания, куда отправили (status == "waiting").
    lobby_channel_id: str | None = None

    def out(self) -> dict:
        return {
            "id": self.id,
            "star_id": self.star_id,
            "channel_id": self.channel_id,
            "user_id": self.user_id,
            "status": self.status,
            "lobby_channel_id": self.lobby_channel_id,
        }


# (user_id, channel_id) -> срок действия пропуска
_passes: dict[tuple[str, str], float] = {}
_knocks: dict[str, Knock] = {}


def _expire() -> list[Knock]:
    """Убирает просроченное; возвращает стуки, оставшиеся без ответа (чтобы сообщить людям)."""
    now = _now()
    for key in [k for k, until in _passes.items() if until <= now]:
        del _passes[key]
    expired = [k for k in _knocks.values() if k.expires_at <= now]
    for knock in expired:
        del _knocks[knock.id]
    return expired


def grant_pass(user_id: str, channel_id: str, ttl: float = PASS_TTL_SEC) -> None:
    until = _now() + ttl
    _passes[(user_id, channel_id)] = max(until, _passes.get((user_id, channel_id), 0))


def has_pass(user_id: str, channel_id: str) -> bool:
    _expire()
    return (user_id, channel_id) in _passes


def consume_pass(user_id: str, channel_id: str) -> bool:
    _expire()
    return _passes.pop((user_id, channel_id), None) is not None


def knock(star_id: str, channel_id: str, user_id: str) -> tuple[Knock, bool]:
    """Новый стук или уже существующий того же человека в ту же дверь. Второе — создан ли новый."""
    _expire()
    for existing in _knocks.values():
        if existing.channel_id == channel_id and existing.user_id == user_id:
            return existing, False
    created = Knock(star_id=star_id, channel_id=channel_id, user_id=user_id)
    _knocks[created.id] = created
    return created, True


def get(knock_id: str) -> Knock | None:
    _expire()
    return _knocks.get(knock_id)


def remove(knock_id: str) -> Knock | None:
    return _knocks.pop(knock_id, None)


def send_to_waiting(knock_id: str, lobby_channel_id: str) -> Knock | None:
    knock_ = _knocks.get(knock_id)
    if knock_:
        knock_.status = "waiting"
        knock_.lobby_channel_id = lobby_channel_id
        knock_.expires_at = _now() + WAITING_TTL_SEC
    return knock_


def star_knocks(star_id: str) -> list[Knock]:
    _expire()
    return sorted((k for k in _knocks.values() if k.star_id == star_id), key=lambda k: k.created_at)


def expire_now() -> list[Knock]:
    return _expire()


def left_lobby(star_id: str, lobby_channel_id: str, user_id: str) -> list[Knock]:
    """Человек ушёл из зала ожидания — его ожидание снимается."""
    gone = [
        k
        for k in _knocks.values()
        if k.star_id == star_id
        and k.user_id == user_id
        and k.status == "waiting"
        and k.lobby_channel_id == lobby_channel_id
    ]
    for knock_ in gone:
        del _knocks[knock_.id]
    return gone


def forget_user(star_id: str, user_id: str) -> None:
    """Выгнали или заблокировали — его стуки в этой Звезде больше не действуют."""
    for knock_ in [k for k in _knocks.values() if k.star_id == star_id and k.user_id == user_id]:
        del _knocks[knock_.id]


def reset() -> None:
    """Для тестов."""
    _passes.clear()
    _knocks.clear()

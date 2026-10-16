"""Правила Созвездия: лимиты, роли и права. Чистые функции — без БД."""

from __future__ import annotations

from enum import Enum

# --- Лимиты ---------------------------------------------------------------

MAX_OWNED_STARS = 2
MAX_STAR_MEMBERS = 50
GAMING_MAX_SATELLITES = 3
GAMING_MAX_PLANETS = 5
PLANET_MAX_CAPACITY = 25
MAX_MESSAGE_LENGTH = 4000

STAR_KINDS = ("gaming", "work")
CHANNEL_KINDS = ("satellite", "planet")

# Комнаты карты офиса и их вместимость по умолчанию.
ROOM_KINDS: dict[str, int] = {
    "coworking": 20,
    "meeting": 8,
    "smoking": 4,
    "kitchen": 6,
    "custom": 10,
}
DEFAULT_PLANET_CAPACITY = 10


def default_capacity(room_kind: str | None) -> int:
    return ROOM_KINDS.get(room_kind or "", DEFAULT_PLANET_CAPACITY)


def channel_limit(star_kind: str, channel_kind: str) -> int | None:
    """Максимум каналов данного вида в Звезде; None — без ограничений."""
    if star_kind != "gaming":
        return None
    return GAMING_MAX_SATELLITES if channel_kind == "satellite" else GAMING_MAX_PLANETS


# --- Роли -----------------------------------------------------------------

ROLES = ("member", "moderator", "admin", "owner")
_RANK = {role: i for i, role in enumerate(ROLES)}


def rank(role: str) -> int:
    return _RANK.get(role, -1)


def outranks(actor_role: str, target_role: str) -> bool:
    """Действовать можно только над теми, у кого роль ниже."""
    return rank(actor_role) > rank(target_role)


# --- Права ----------------------------------------------------------------


class Perm(str, Enum):
    INVITE = "invite"
    DELETE_MESSAGES = "delete_messages"
    KICK = "kick"
    MANAGE_CHANNELS = "manage_channels"
    VOICE_MODERATE = "voice_moderate"
    EDIT_MAP = "edit_map"


# Владелец настраивает права только для этих ролей; админ и владелец имеют все.
CONFIGURABLE_ROLES = ("moderator", "member")

# Что вообще можно выдать роли. Блокировка и управление ролями сюда не входят:
# блокировать могут только владелец и админ.
GRANTABLE: dict[str, frozenset[Perm]] = {
    "moderator": frozenset(Perm),
    "member": frozenset({Perm.INVITE}),
}

DEFAULT_ROLE_PERMISSIONS: dict[str, list[str]] = {
    "moderator": [
        Perm.INVITE.value,
        Perm.DELETE_MESSAGES.value,
        Perm.KICK.value,
        Perm.VOICE_MODERATE.value,
    ],
    "member": [Perm.INVITE.value],
}


def normalize_role_permissions(raw: dict | None) -> dict[str, list[str]]:
    """Оставляет только допустимые права и только для настраиваемых ролей."""
    raw = raw or {}
    result: dict[str, list[str]] = {}
    for role in CONFIGURABLE_ROLES:
        values = raw.get(role, DEFAULT_ROLE_PERMISSIONS[role])
        allowed = {p.value for p in GRANTABLE[role]}
        result[role] = sorted({v for v in values if v in allowed})
    return result


def has_perm(role: str, perm: Perm, role_permissions: dict | None) -> bool:
    if role in ("owner", "admin"):
        return True
    if role not in CONFIGURABLE_ROLES:
        return False
    return perm.value in normalize_role_permissions(role_permissions)[role]


def effective_permissions(role: str, role_permissions: dict | None) -> list[str]:
    return [p.value for p in Perm if has_perm(role, p, role_permissions)]


def can_kick(actor_role: str, target_role: str, role_permissions: dict | None) -> bool:
    return has_perm(actor_role, Perm.KICK, role_permissions) and outranks(actor_role, target_role)


def can_ban(actor_role: str, target_role: str) -> bool:
    return actor_role in ("owner", "admin") and outranks(actor_role, target_role)


def can_set_role(actor_role: str, target_role: str, new_role: str) -> bool:
    """Модераторов назначают владелец и админы, админов — только владелец.
    Роль владельца передаётся отдельно (передача Звезды)."""
    if new_role not in ("member", "moderator", "admin") or new_role == target_role:
        return False
    if not outranks(actor_role, target_role):
        return False
    if "admin" in (new_role, target_role):
        return actor_role == "owner"
    return actor_role in ("owner", "admin")


def can_delete_message(
    actor_id: str,
    actor_role: str,
    sender_id: str | None,
    sender_role: str | None,
    role_permissions: dict | None,
) -> bool:
    if sender_id is not None and sender_id == actor_id:
        return True
    if not has_perm(actor_role, Perm.DELETE_MESSAGES, role_permissions):
        return False
    # Автор уже не в Звезде — его сообщения может убрать любой с правом удаления.
    return sender_role is None or outranks(actor_role, sender_role)

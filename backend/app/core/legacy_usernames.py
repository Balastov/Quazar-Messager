"""Старые ники не латиницей → латинский ник (Бабан → Baban), прежний ник — в «Имя».

Запускается при старте (main.py) до уникального индекса по lower(username):
после транслитерации «Ваня» и «ваня» иначе столкнулись бы.
"""

import logging
import re
import unicodedata

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.profile import (
    NAME_MAX,
    RESERVED_USERNAMES,
    USERNAME_MAX,
    USERNAME_MIN,
    normalize_person_name,
)

log = logging.getLogger(__name__)

# Практическая транслитерация (как в загранпаспортах, но «х» → kh, «ц» → ts): читается привычно.
_CYRILLIC = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
    # Украинский и белорусский.
    "і": "i", "ї": "yi", "є": "ye", "ґ": "g", "ў": "u",
}

_LATIN_NICK = re.compile(r"^[A-Za-z][A-Za-z0-9_.]*$")


def transliterate(value: str) -> str:
    """Кириллица → латиница с сохранением регистра: Жора → Zhora, ЖОРА → ZHORA.
    Прочие буквы — их латинская основа (é → e), остальное не трогаем."""
    out: list[str] = []
    for i, ch in enumerate(value):
        low = ch.lower()
        if low in _CYRILLIC:
            latin = _CYRILLIC[low]
            if ch != low and latin:
                nxt = value[i + 1] if i + 1 < len(value) else ""
                latin = latin.upper() if nxt.isupper() else latin.capitalize()
            out.append(latin)
        else:
            out.append(unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode() or ch)
    return "".join(out)


def latin_nick(old: str) -> str:
    """Латинский ник по правилам app/core/profile.py (без проверки занятости)."""
    nick = re.sub(r"[^A-Za-z0-9_.]", "", transliterate(old))
    nick = re.sub(r"\.{2,}", ".", nick)
    nick = nick.lstrip("0123456789_.").rstrip(".")
    nick = nick[:USERNAME_MAX].rstrip(".")
    if len(nick) < USERNAME_MIN:
        nick = f"user_{nick}" if nick else "user"
    if nick.lower() in RESERVED_USERNAMES:
        nick = f"{nick}_1"
    return nick


def with_suffix(nick: str, n: int) -> str:
    suffix = f"_{n}"
    return nick[: USERNAME_MAX - len(suffix)].rstrip(".") + suffix


def name_from_nick(old: str) -> str | None:
    """«Иван_Петров» → «Иван Петров» для поля «Имя»; None — если не годится в имя."""
    try:
        return normalize_person_name(re.sub(r"[_.]+", " ", old)[:NAME_MAX], censor=False)
    except ValueError:
        return None


def needs_migration(username: str) -> bool:
    """Только ники с нелатинскими символами — латинские старые ники не трогаем."""
    return not username.isascii()


async def migrate_legacy_usernames(conn: AsyncConnection) -> int:
    rows = (
        await conn.execute(text("SELECT id, username, first_name FROM users WHERE username !~ '^[\\x00-\\x7F]*$'"))
    ).all()
    renamed = 0
    for user_id, old, first_name in rows:
        if not needs_migration(old):
            continue
        base = latin_nick(old)
        nick, n = base, 1
        while (
            await conn.execute(
                text("SELECT 1 FROM users WHERE lower(username) = lower(:n) AND id != :id LIMIT 1"),
                {"n": nick, "id": user_id},
            )
        ).first():
            n += 1
            nick = with_suffix(base, n)
        params = {"id": user_id, "nick": nick}
        sql = "UPDATE users SET username = :nick"
        new_first = None if first_name else name_from_nick(old)
        if new_first:
            sql += ", first_name = :first"
            params["first"] = new_first
        await conn.execute(text(sql + " WHERE id = :id"), params)
        log.warning("legacy username %r → %r (user %s)", old, nick, user_id)
        renamed += 1
    return renamed

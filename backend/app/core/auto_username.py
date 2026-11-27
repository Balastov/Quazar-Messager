"""Никнейм для упрощённой регистрации (вход в Padma, docs/PADMA-SSO.md, этап 3):
«Иванов Пётр» → ivanov_petr; занят — ivanov_petr2, ivanov_petr3…; не выходит — user_12345."""

import secrets
import unicodedata

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.profile import USERNAME_MAX, normalize_username
from app.models.user import User

# Таблица из docs/PADMA-SSO.md (ё → e, ъ и ь пропускаются) плюс украинские и белорусские буквы.
_CYRILLIC = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya", "і": "i", "ї": "yi", "є": "ye", "ґ": "g", "ў": "u",
}
FALLBACK_TRIES = 20


def latin_part(value: str | None) -> str:
    """Имя или фамилия → строчная латиница: кириллица по таблице, латиница с диакритикой — без неё
    (é → e), всё прочее (пробелы, дефисы, апострофы, цифры, другие алфавиты) удаляется."""
    out = []
    for ch in (value or "").lower():
        if ch in _CYRILLIC:
            out.append(_CYRILLIC[ch])
            continue
        base = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
        out.append("".join(c for c in base if "a" <= c <= "z"))
    return "".join(out)


def base_parts(last_name: str | None, first_name: str | None) -> tuple[str, str]:
    return latin_part(last_name), latin_part(first_name)


def compose(last: str, first: str, suffix: str = "") -> str:
    """фамилия_имя + суффикс в пределах USERNAME_MAX: сначала обрезается фамилия,
    имя — только если и одной буквы фамилии не остаётся."""
    if not last or not first:
        return (last or first)[: USERNAME_MAX - len(suffix)] + suffix
    room = USERNAME_MAX - len(suffix) - 1  # минус «_»
    first = first[: max(1, room - 1)]
    return f"{last[: room - len(first)]}_{first}{suffix}"


def _valid(candidate: str) -> bool:
    try:
        normalize_username(candidate)  # длина, формат, зарезервированные, фильтр слов
        return True
    except ValueError:
        return False


BATCH = 50


async def _free(db: AsyncSession, candidates: list[str]) -> str | None:
    """Первый свободный (без учёта регистра) из списка — одним запросом."""
    rows = await db.execute(select(func.lower(User.username)).where(func.lower(User.username).in_([c.lower() for c in candidates])))
    taken = set(rows.scalars())
    return next((c for c in candidates if c.lower() not in taken), None)


async def auto_username(db: AsyncSession, last_name: str | None, first_name: str | None) -> str:
    last, first = base_parts(last_name, first_name)
    if (last or first) and _valid(compose(last, first)):
        for start in range(1, 1000, BATCH):
            batch = [compose(last, first, "" if n == 1 else str(n)) for n in range(start, start + BATCH)]
            if free := await _free(db, [c for c in batch if _valid(c)]):
                return free
    return await fallback_username(db)


async def fallback_username(db: AsyncSession) -> str:
    """user_<5 случайных цифр>, свободный (без учёта регистра)."""
    for _ in range(FALLBACK_TRIES):
        candidate = f"user_{secrets.randbelow(100_000):05d}"
        exists = (await db.execute(select(User.id).where(func.lower(User.username) == candidate).limit(1))).first()
        if not exists:
            return candidate
    return f"user_{secrets.token_hex(6)}"

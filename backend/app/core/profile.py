"""Поля профиля: никнейм, почта, имя и фамилия — общие правила для регистрации и правки."""

import re
import unicodedata

from pydantic import TypeAdapter, EmailStr, ValidationError

from app.core.censor import find_violation, violation_message

USERNAME_MIN = 3
USERNAME_MAX = 32
NAME_MAX = 64
EMAIL_MAX = 254

# Латиница, цифры, «_» и «.»; начинается с буквы. Так ник читается в @упоминаниях
# (backend/app/core/notify.py) и одинаково набирается на любой раскладке.
_USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.]*$")

# @все и служебные имена: такой ник ломал бы упоминания или выдавал себя за сервис.
RESERVED_USERNAMES = {
    "all", "everyone", "here", "admin", "administrator", "support", "system", "quazar",
    "moderator", "root", "me", "saved",
}

_email = TypeAdapter(EmailStr)


def normalize_username(value: str) -> str:
    """Проверяет никнейм; регистр сохраняется, уникальность — без учёта регистра."""
    v = (value or "").strip().lstrip("@")
    if not USERNAME_MIN <= len(v) <= USERNAME_MAX:
        raise ValueError(f"Никнейм — от {USERNAME_MIN} до {USERNAME_MAX} символов")
    if not _USERNAME.match(v):
        raise ValueError(
            "Никнейм — латинские буквы, цифры, «_» и «.», начинается с буквы"
        )
    if v.endswith(".") or ".." in v:
        raise ValueError("Точка не может стоять в конце никнейма или два раза подряд")
    if v.lower() in RESERVED_USERNAMES:
        raise ValueError("Этот никнейм зарезервирован")
    if category := find_violation(v, nickname=True):
        raise ValueError(f"Никнейм содержит {violation_message(category)}. Выберите другой")
    return v


def normalize_email(value: str | None) -> str | None:
    """Пустая строка — почты нет. Хранится в нижнем регистре."""
    v = (value or "").strip()
    if not v:
        return None
    if len(v) > EMAIL_MAX:
        raise ValueError("Слишком длинный адрес почты")
    try:
        return str(_email.validate_python(v)).lower()
    except ValidationError:
        raise ValueError("Некорректный адрес почты") from None


def normalize_person_name(value: str | None, label: str = "Имя", *, censor: bool = True) -> str | None:
    """Имя или фамилия на любом языке. Пустое — не указано.
    censor=False — для уже существующих данных (перенос старого ника в имя)."""
    v = " ".join((value or "").split())
    if not v:
        return None
    if len(v) > NAME_MAX:
        raise ValueError(f"Не длиннее {NAME_MAX} символов")
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Co", "Cs") for ch in v):
        raise ValueError("Недопустимые символы")
    if not any(ch.isalpha() for ch in v):
        raise ValueError("Нужна хотя бы одна буква")
    if censor and (category := find_violation(v, nickname=False)):
        raise ValueError(f"{label} содержит {violation_message(category)}")
    return v


def display_name(first_name: str | None, last_name: str | None, username: str) -> str:
    """«Имя Фамилия», если указаны, иначе никнейм."""
    return " ".join(p for p in (first_name, last_name) if p) or username

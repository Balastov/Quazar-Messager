"""Фоны приложения (личный) и Звёзд: картинки под MEDIA_ROOT/backgrounds, раздаются /media/backgrounds.

Имя файла случайное: адрес не угадать по id пользователя или Звезды, а новая картинка
сразу получает новый URL — кеш nginx на /media её не прячет. Фон чата сюда не относится:
он шифруется клиентом и хранится как вложение чата (см. app.core.attachments).
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from app.core.avatars import detect_image, media_root

MAX_BACKGROUND_BYTES = 5 * 1024 * 1024
BACKGROUND_URL_PREFIX = "/media/backgrounds/"

_SAFE_NAME = re.compile(r"^[0-9a-f]{32}\.(jpg|png|gif|webp)$")


class BackgroundRejected(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def backgrounds_dir() -> Path:
    directory = media_root() / "backgrounds"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def check_background(data: bytes) -> str:
    """Возвращает расширение файла или бросает BackgroundRejected."""
    if len(data) > MAX_BACKGROUND_BYTES:
        raise BackgroundRejected(413, "Картинка для фона должна быть не больше 5 МБ")
    detected = detect_image(data)
    if not detected:
        raise BackgroundRejected(422, "Подойдёт картинка JPEG, PNG, WebP или GIF")
    return detected[1]


def save_background(data: bytes, ext: str) -> str:
    name = f"{uuid.uuid4().hex}{ext}"
    (backgrounds_dir() / name).write_bytes(data)
    return BACKGROUND_URL_PREFIX + name


def delete_background(url: str | None) -> None:
    """Удаляет файл по его URL; чужие и странные адреса игнорирует."""
    if not url or not url.startswith(BACKGROUND_URL_PREFIX):
        return
    name = url[len(BACKGROUND_URL_PREFIX) :]
    if not _SAFE_NAME.match(name):
        return
    try:
        (backgrounds_dir() / name).unlink(missing_ok=True)
    except OSError:
        pass

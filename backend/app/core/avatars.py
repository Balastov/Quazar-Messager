"""Avatar upload helpers: validate image magic bytes and persist under MEDIA_ROOT."""
from __future__ import annotations

import re
from pathlib import Path

from app.core.config import settings

MAX_AVATAR_BYTES = 3 * 1024 * 1024
AVATAR_URL_PREFIX = "/media/avatars/"

_SAFE_USER_ID = re.compile(r"^[0-9a-fA-F-]{36}$")


def media_root() -> Path:
    root = Path(settings.MEDIA_ROOT).resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "avatars").mkdir(parents=True, exist_ok=True)
    return root


def avatars_dir() -> Path:
    return media_root() / "avatars"


def detect_image(data: bytes) -> tuple[str, str] | None:
    """Return (content_type, extension) or None if unsupported."""
    if len(data) < 12:
        return None
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def avatar_public_url(user_id: str, ext: str) -> str:
    return f"{AVATAR_URL_PREFIX}{user_id}{ext}"


def save_avatar(user_id: str, data: bytes, ext: str) -> str:
    if not _SAFE_USER_ID.match(user_id):
        raise ValueError("Invalid user id")

    directory = avatars_dir()
    # Remove previous avatar files for this user (any extension).
    for old in directory.glob(f"{user_id}.*"):
        try:
            old.unlink()
        except OSError:
            pass

    path = directory / f"{user_id}{ext}"
    path.write_bytes(data)
    return avatar_public_url(user_id, ext)


def delete_avatar_files(user_id: str) -> None:
    if not _SAFE_USER_ID.match(user_id):
        return
    for old in avatars_dir().glob(f"{user_id}.*"):
        try:
            old.unlink()
        except OSError:
            pass

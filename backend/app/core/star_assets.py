"""Файлы стикеров, эмодзи и звуков Звезды: MEDIA_ROOT/stars/<star_id>/<asset_id>.<ext>.

Раздаются публично (/media/stars/…), как аватары: в Звёздах нет сквозного шифрования, а имя
файла — случайный id.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from app.core.avatars import detect_image, media_root

URL_PREFIX = "/media/stars/"
MAX_BYTES = {"sticker": 512 * 1024, "emoji": 128 * 1024, "sound": 400 * 1024}
_SAFE_ID = re.compile(r"^[0-9a-f-]{36}$")


def stars_media_dir() -> Path:
    path = media_root() / "stars"
    path.mkdir(parents=True, exist_ok=True)
    return path


def detect_audio(data: bytes) -> tuple[str, str] | None:
    """(mime, ext) по сигнатуре: Ogg, MP3, WAV, WebM, MP4/M4A."""
    if len(data) < 12:
        return None
    if data[:4] == b"OggS":
        return "audio/ogg", ".ogg"
    if data[:3] == b"ID3" or (data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg", ".mp3"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav", ".wav"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm", ".webm"
    if data[4:8] == b"ftyp":
        return "audio/mp4", ".m4a"
    return None


def detect(kind: str, data: bytes) -> tuple[str, str] | None:
    return detect_audio(data) if kind == "sound" else detect_image(data)


def save(star_id: str, asset_id: str, data: bytes, ext: str) -> str:
    if not _SAFE_ID.match(star_id) or not _SAFE_ID.match(asset_id):
        raise ValueError("bad id")
    directory = stars_media_dir() / star_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{asset_id}{ext}").write_bytes(data)
    return f"{URL_PREFIX}{star_id}/{asset_id}{ext}"


def delete(url: str) -> None:
    if not url.startswith(URL_PREFIX):
        return
    path = (stars_media_dir() / url[len(URL_PREFIX):]).resolve()
    if stars_media_dir().resolve() in path.parents:
        path.unlink(missing_ok=True)


def delete_star(star_id: str) -> None:
    if _SAFE_ID.match(star_id):
        shutil.rmtree(stars_media_dir() / star_id, ignore_errors=True)

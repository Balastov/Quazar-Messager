"""Стикерпаки: папки backend/stickers/<pack_id>/ с manifest.json и Lottie-анимациями.

Паки собирает scripts/sticker_pack.py. Стикер в сообщении — текст «STK1:<pack>/<id>»: в личных
чатах он шифруется вместе с остальными сообщениями, поэтому сервер стикеры не разбирает.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

STICKERS_DIR = Path(__file__).resolve().parents[2] / "stickers"
_PACK_ID_RE = re.compile(r"^[a-z0-9_]{2,32}$")
_STICKER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class Sticker:
    id: str
    emoji: str
    file: str


@dataclass(frozen=True)
class StickerPack:
    id: str
    version: int
    title: str
    author: str
    license: str
    license_url: str
    source_url: str
    default: bool
    stickers: tuple[Sticker, ...]


def _load_pack(pack_dir: Path) -> StickerPack:
    data = json.loads((pack_dir / "manifest.json").read_text(encoding="utf-8"))
    if data.get("id") != pack_dir.name or not _PACK_ID_RE.match(pack_dir.name):
        raise ValueError(f"{pack_dir}: id в manifest.json должен совпадать с именем папки")
    stickers = []
    for s in data["stickers"]:
        file = s["file"]
        if not _STICKER_ID_RE.match(s["id"]) or Path(file).name != file or not (pack_dir / file).is_file():
            raise ValueError(f"{pack_dir.name}/{s.get('id')}: плохой id или нет файла {file}")
        stickers.append(Sticker(id=s["id"], emoji=s.get("emoji", ""), file=file))
    return StickerPack(
        id=data["id"],
        version=int(data.get("version", 1)),
        title=data["title"],
        author=data.get("author", ""),
        license=data.get("license", ""),
        license_url=data.get("license_url", ""),
        source_url=data.get("source_url", ""),
        default=bool(data.get("default", False)),
        stickers=tuple(stickers),
    )


@lru_cache(maxsize=1)
def all_packs() -> tuple[StickerPack, ...]:
    """Все паки на сервере. Сломанный пак пропускаем, чтобы не ронять остальные."""
    packs = []
    if STICKERS_DIR.is_dir():
        for pack_dir in sorted(p for p in STICKERS_DIR.iterdir() if (p / "manifest.json").is_file()):
            try:
                packs.append(_load_pack(pack_dir))
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                logger.error("sticker pack %s skipped: %s", pack_dir.name, exc)
    # Паки по умолчанию — первыми.
    return tuple(sorted(packs, key=lambda p: (not p.default, p.title.lower())))


def packs_for_user(user_id: str) -> list[StickerPack]:
    """Установленные у пользователя паки. Пока это паки по умолчанию — они есть у всех."""
    return [p for p in all_packs() if p.default]

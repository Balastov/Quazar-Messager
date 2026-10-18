"""Сборка стикерпаков для backend/stickers/<pack_id>/.

Пак — папка с Lottie-анимациями (*.json) и manifest.json. Сервер отдаёт их как есть,
клиенты рисуют Lottie (веб — lottie-web, мобильное приложение — lottie-react-native).

    # Пак по умолчанию: анимированные Noto Emoji (Google, CC BY 4.0)
    python scripts/sticker_pack.py noto

    # Свой пак из папки с .tgs (стикеры Telegram) или .json (Lottie) — только если у вас есть права
    python scripts/sticker_pack.py import ./my-pack --id my_pack --title "Мой пак" \\
        --author "Автор" --license "CC BY 4.0" --license-url https://... [--default]

Эмодзи для стикера при импорте берётся из имени файла, если оно начинается с эмодзи
(«😂_laugh.tgs»), иначе стикер ищется только по названию.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path

STICKERS_DIR = Path(__file__).resolve().parent.parent / "stickers"
PACK_ID_RE = re.compile(r"^[a-z0-9_]{2,32}$")
STICKER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_STICKER_BYTES = 512 * 1024

NOTO_URL = "https://fonts.gstatic.com/s/e/notoemoji/latest/{code}/lottie.json"
# Порядок = порядок в панели стикеров.
NOTO_EMOJI = (
    "😀😁😂🤣😅😊😉😍🥰😘😋😜🤪😎🤓🥳🤩😏🙃🫠🥲🥹😇🤗🤔🫡🤫🤭🫣🙄😬😴🥱😐😶😒"
    "😞😢😭🥺😤😠😡🤬🤯😳😱😨🥶🥵🤢🤮🤒😵‍💫🤡💩👻💀👽🤖😈🙈😹🙀"
    "👍👎👏🙏💪🤝👋✌️🤞👌🫶❤️💔❤️‍🔥💯🔥✨🎉🎂☕🍻🚀🦄🐸"
)


def split_emoji(text: str) -> list[str]:
    """Разбивает строку на эмодзи с учётом ZWJ-последовательностей и FE0F."""
    out: list[str] = []
    for ch in text:
        if out and (ch in ("‍", "️") or out[-1].endswith("‍")):
            out[-1] += ch
        else:
            out.append(ch)
    return out


def codepoint(emoji: str) -> str:
    """«❤️‍🔥» → «2764_fe0f_200d_1f525» — как в именах Noto."""
    return "_".join(f"{ord(c):x}" for c in emoji)


def is_lottie(data: object) -> bool:
    return isinstance(data, dict) and isinstance(data.get("layers"), list) and "fr" in data


def write_pack(pack_dir: Path, manifest: dict) -> None:
    (pack_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{manifest['id']}: {len(manifest['stickers'])} стикеров → {pack_dir}")


def fetch_noto() -> None:
    pack_dir = STICKERS_DIR / "noto"
    pack_dir.mkdir(parents=True, exist_ok=True)
    stickers = []
    for emoji in split_emoji(NOTO_EMOJI):
        # В адресах Noto нет FE0F у одиночных эмодзи («2764», а не «2764_fe0f»).
        code = codepoint(emoji.replace("️", "") if "‍" not in emoji else emoji)
        with urllib.request.urlopen(NOTO_URL.format(code=code), timeout=30) as resp:
            raw = resp.read()
        data = json.loads(raw)
        if not is_lottie(data) or len(raw) > MAX_STICKER_BYTES:
            sys.exit(f"{emoji} ({code}): не Lottie или больше {MAX_STICKER_BYTES} байт")
        (pack_dir / f"{code}.json").write_bytes(raw)
        stickers.append({"id": code, "emoji": emoji, "file": f"{code}.json"})
    write_pack(
        pack_dir,
        {
            "id": "noto",
            "version": 1,
            "title": "Noto Emoji",
            "author": "Google",
            "license": "CC BY 4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "source_url": "https://googlefonts.github.io/noto-emoji-animation/",
            "default": True,
            "stickers": stickers,
        },
    )


def import_pack(args: argparse.Namespace) -> None:
    if not PACK_ID_RE.match(args.id):
        sys.exit("--id: латиница, цифры и _, 2–32 символа")
    src = Path(args.src)
    files = sorted(p for p in src.iterdir() if p.suffix.lower() in (".tgs", ".json"))
    if not files:
        sys.exit(f"В {src} нет .tgs и .json")
    pack_dir = STICKERS_DIR / args.id
    if pack_dir.exists():
        shutil.rmtree(pack_dir)
    pack_dir.mkdir(parents=True)

    stickers = []
    for i, path in enumerate(files, 1):
        raw = path.read_bytes()
        if path.suffix.lower() == ".tgs":
            raw = gzip.decompress(raw)  # TGS — это Lottie JSON в gzip
        data = json.loads(raw)
        if not is_lottie(data):
            sys.exit(f"{path.name}: это не Lottie-анимация")
        raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
        if len(raw) > MAX_STICKER_BYTES:
            sys.exit(f"{path.name}: больше {MAX_STICKER_BYTES} байт")
        lead = split_emoji(path.stem)[0] if path.stem else ""
        emoji = lead if not lead.isascii() else ""
        sid = re.sub(r"[^A-Za-z0-9_-]", "", path.stem.removeprefix(emoji).strip("_- ")) or f"s{i}"
        if not STICKER_ID_RE.match(sid) or any(s["id"] == sid for s in stickers):
            sid = f"s{i}"
        (pack_dir / f"{sid}.json").write_bytes(raw)
        stickers.append({"id": sid, "emoji": emoji, "file": f"{sid}.json"})

    write_pack(
        pack_dir,
        {
            "id": args.id,
            "version": args.version,
            "title": args.title,
            "author": args.author,
            "license": args.license,
            "license_url": args.license_url,
            "source_url": args.source_url,
            "default": args.default,
            "stickers": stickers,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("noto", help="скачать пак Noto Emoji")
    imp = sub.add_parser("import", help="собрать пак из .tgs / .json")
    imp.add_argument("src")
    imp.add_argument("--id", required=True)
    imp.add_argument("--title", required=True)
    imp.add_argument("--author", required=True)
    imp.add_argument("--license", required=True)
    imp.add_argument("--license-url", default="")
    imp.add_argument("--source-url", default="")
    imp.add_argument("--version", type=int, default=1, help="увеличьте, если меняете файлы пака")
    imp.add_argument("--default", action="store_true", help="установлен у всех по умолчанию")
    args = parser.parse_args()
    if args.cmd == "noto":
        fetch_noto()
    else:
        import_pack(args)


if __name__ == "__main__":
    main()

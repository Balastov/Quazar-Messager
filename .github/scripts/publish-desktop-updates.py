"""Публикация проверенных файлов: сначала все пакеты, затем атомарная замена метаданных."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen


def download(staging, manifest):
    base = manifest.get("download_base")
    if not base:
        return
    if not re.fullmatch(r"https://github\.com/Balastov/Quazar-Messager/releases/download/desktop-v" + re.escape(manifest["version"]) + r"-pilot\.\d+", base):
        raise ValueError("Unexpected download source")

    def get(item):
        channel, entry = item
        name, asset = entry["name"], entry["asset"]
        allowed = package_pattern(manifest["version"], channel)
        if not (re.fullmatch(allowed, name) or name == ALL[channel]) or not (re.fullmatch(allowed, asset) or asset == metadata_asset(channel)):
            raise ValueError("Unexpected download filename")
        folder = staging / f"quazar-desktop-{channel}"
        if folder.is_symlink(): raise ValueError("Symlink download directory")
        folder.mkdir(exist_ok=True)
        target = folder / name
        partial = target.with_name(name + ".part")
        if target.is_symlink() or partial.is_symlink(): raise ValueError("Symlink download target")
        if target.exists() and digest(target) == entry["sha256"]: return
        if partial.exists() and partial.stat().st_size >= entry["size"]:
            if partial.stat().st_size == entry["size"] and digest(partial) == entry["sha256"]:
                os.replace(partial, target); return
            partial.unlink()
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"User-Agent": "Quazar-Update-Publisher"}
        if offset: headers["Range"] = f"bytes={offset}-"
        with urlopen(Request(f"{base}/{asset}", headers=headers), timeout=60) as response:
            append = offset > 0 and response.status == 206 and response.headers.get("Content-Range", "").startswith(f"bytes {offset}-")
            if response.status not in (200, 206) or (response.status == 206 and offset and not append): raise ValueError("Unexpected download range")
            with partial.open("ab" if append else "wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
        if partial.stat().st_size != entry["size"] or digest(partial) != entry["sha256"]:
            raise ValueError(f"Downloaded package integrity check failed: {name}")
        os.replace(partial, target)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(get, [(channel, entry) for channel, entries in manifest["channels"].items() for entry in entries]))

CHANNELS = {"win-x64": "latest.yml", "mac-arm64": "latest-mac.yml", "mac-x64": "latest-mac.yml"}
# Приложение для Android публикуется вместе с ПК-версией, когда выпуск его содержит.
OPTIONAL = {"android": "latest.json"}
ALL = {**CHANNELS, **OPTIONAL}


def package_pattern(version, channel):
    if channel == "android":
        return rf"Quazar-{re.escape(version)}-android\.apk"
    return rf"Quazar-{re.escape(version)}-{re.escape(channel)}\.(?:exe|dmg|zip)(?:\.blockmap)?"


def metadata_asset(channel):
    """Имя файла метаданных среди файлов выпуска на GitHub: latest-win-x64.yml, latest-android.json…"""
    return f"latest-{channel}{Path(ALL[channel]).suffix}"


def published_version(path):
    text = path.read_text()
    if path.suffix == ".json":
        try:
            value = json.loads(text).get("version", "")
        except (ValueError, AttributeError):
            return None
        return value if re.fullmatch(r"\d+\.\d+\.\d+", str(value)) else None
    match = re.search(r"^version:\s*['\"]?(\d+\.\d+\.\d+)", text, re.MULTILINE)
    return match[1] if match else None


# Сколько выпусков хранить на сервере: текущий и предыдущий (для обновления по частям).
KEEP_VERSIONS = 2


def move(src, dst):
    """os.replace, который работает и между дисками: файлы обновлений лежат на HDD, черновик — на SSD."""
    try:
        os.replace(src, dst)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        temporary = dst.with_name(f".{dst.name}.copy")
        shutil.copyfile(src, temporary)
        os.replace(temporary, dst)
        os.unlink(src)


def version_key(version):
    return tuple(map(int, version.split(".")))


def prune(root, channels, keep=KEEP_VERSIONS):
    """Удаляет пакеты старых выпусков: остаются опубликованный и `keep - 1` предыдущих.

    Пакеты новее опубликованных метаданных не трогаем — это выпуск, который публикуется сейчас.
    Канал без метаданных пропускаем: непонятно, какая версия у людей текущая.
    """
    removed = 0
    for channel in channels:
        folder = root / channel
        metadata = folder / ALL[channel]
        if folder.is_symlink() or not folder.is_dir() or metadata.is_symlink() or not metadata.is_file():
            continue
        current = published_version(metadata)
        if not current:
            continue
        found = {}
        for path in folder.iterdir():
            match = re.fullmatch(r"Quazar-(\d+\.\d+\.\d+)-.+", path.name)
            if match and path.is_file() and not path.is_symlink() and re.fullmatch(package_pattern(match[1], channel), path.name):
                found.setdefault(match[1], []).append(path)
        released = sorted((v for v in found if version_key(v) <= version_key(current)), key=version_key)
        for version in released[:-keep]:
            for path in found[version]:
                path.unlink()
                removed += 1
    return removed


def clean_staging(base, keep=None, max_age=24 * 3600):
    """Удаляет черновики прерванных публикаций (на системном диске) старше суток."""
    base = Path(base)
    if base.is_symlink() or not base.is_dir():
        return 0
    removed = 0
    for folder in base.iterdir():
        if folder == keep or folder.is_symlink() or not folder.is_dir() or not re.fullmatch(r"\d+", folder.name):
            continue
        if time.time() - folder.stat().st_mtime > max_age:
            shutil.rmtree(folder)
            removed += 1
    return removed


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def publish(staging, root):
    if Path(staging).is_symlink() or Path(root).is_symlink():
        raise ValueError("Symlink publication roots are not allowed")
    staging, root = Path(staging).resolve(), Path(root).resolve()
    manifest = json.loads((staging / "publication.json").read_text())
    version = manifest.get("version", "")
    channels = set(manifest.get("channels", {}))
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not set(CHANNELS) <= channels or not channels <= set(ALL):
        raise ValueError("Invalid update publication")
    download(staging, manifest)
    root.mkdir(parents=True, exist_ok=True)
    with (root.parent / ".desktop-updates-publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        prepared = []
        # Валидация всего набора завершается до первого изменения публичного каталога.
        for channel in sorted(channels, key=list(ALL).index):
            metadata = ALL[channel]
            entries = manifest["channels"][channel]
            if not entries or len({entry["name"] for entry in entries}) != len(entries) or metadata not in {entry["name"] for entry in entries}:
                raise ValueError("Missing or duplicate update metadata")
            source = staging / f"quazar-desktop-{channel}"
            destination = root / channel
            if source.is_symlink() or destination.is_symlink():
                raise ValueError("Symlink channel is not allowed")
            current = destination / metadata
            if current.is_symlink():
                raise ValueError("Symlink metadata is not allowed")
            current_version = published_version(current) if current.exists() else None
            if current.exists():
                if not current_version or tuple(map(int, current_version.split('.'))) > tuple(map(int, version.split('.'))):
                    raise ValueError("Update feed downgrade is not allowed")
            for entry in entries:
                name = entry.get("name", "")
                if name != metadata and not re.fullmatch(package_pattern(version, channel), name):
                    raise ValueError("Invalid update file name")
                if not re.fullmatch(r"[a-f0-9]{64}", entry.get("sha256", "")):
                    raise ValueError("Invalid checksum")
                src, dst = source / name, destination / name
                if src.is_symlink() or not src.is_file() or digest(src) != entry["sha256"]:
                    raise ValueError(f"Update integrity check failed: {name}")
                if dst.is_symlink():
                    raise ValueError("Symlink target is not allowed")
                if dst.exists() and name != metadata and digest(dst) != entry["sha256"]:
                    raise ValueError("Published installers must never be overwritten")
                if current.exists() and name == metadata and current_version == version and digest(dst) != entry["sha256"]:
                    raise ValueError("The same version cannot replace update metadata")
                prepared.append((src, dst, name == metadata))
        for src, dst, metadata in prepared:
            if metadata:
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            move(src, dst)
            dst.chmod(0o644)
        for src, dst, metadata in prepared:
            if not metadata:
                continue
            temporary = dst.with_name(dst.name + ".new")
            move(src, temporary)
            temporary.chmod(0o644)
            os.replace(temporary, dst)
        print(f"Published update feeds {version}: {', '.join(sorted(channels, key=list(ALL).index))}")
        report_pruned(prune(root, channels))


def report_pruned(removed):
    if removed:
        print(f"Removed {removed} files of older releases")


def prune_published(root):
    """Та же уборка без публикации — её запускает каждый деплой."""
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        return
    with (root.parent / ".desktop-updates-publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        report_pruned(prune(root, ALL))


STAGING = "/opt/quazar/.desktop-updates-staging"
ROOT = "/opt/quazar/desktop-updates"

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--staging")
    parser.add_argument("--root", default=ROOT)
    parser.add_argument("--prune", action="store_true", help="only remove old releases and stale drafts")
    args = parser.parse_args()
    if args.root != ROOT or (args.prune == bool(args.staging)):
        parser.error("Use either --staging or --prune")
    if args.prune:
        prune_published(args.root)
    else:
        if not re.fullmatch(re.escape(STAGING) + r"/\d+", args.staging):
            parser.error("Unexpected publication paths")
        publish(args.staging, args.root)
        shutil.rmtree(args.staging)
    stale = clean_staging(STAGING)
    if stale:
        print(f"Removed {stale} interrupted publication drafts")

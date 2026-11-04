"""Публикация проверенных файлов: сначала все пакеты, затем атомарная замена метаданных."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
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
        allowed = rf"Quazar-{re.escape(manifest['version'])}-{re.escape(channel)}\.(?:exe|dmg|zip)(?:\.blockmap)?"
        if not (re.fullmatch(allowed, name) or name == CHANNELS[channel]) or not (re.fullmatch(allowed, asset) or asset == f"latest-{channel}.yml"):
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
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or set(manifest.get("channels", {})) != set(CHANNELS):
        raise ValueError("Invalid update publication")
    download(staging, manifest)
    root.mkdir(parents=True, exist_ok=True)
    with (root.parent / ".desktop-updates-publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        prepared = []
        # Валидация всего набора завершается до первого изменения публичного каталога.
        for channel, metadata in CHANNELS.items():
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
            if current.exists():
                match = re.search(r"^version:\s*['\"]?(\d+\.\d+\.\d+)", current.read_text(), re.MULTILINE)
                if not match or tuple(map(int, match[1].split('.'))) > tuple(map(int, version.split('.'))):
                    raise ValueError("Update feed downgrade is not allowed")
            for entry in entries:
                name = entry.get("name", "")
                if name != metadata and not re.fullmatch(rf"Quazar-{re.escape(version)}-{re.escape(channel)}\.(?:exe|dmg|zip)(?:\.blockmap)?", name):
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
                if current.exists() and name == metadata and match[1] == version and digest(dst) != entry["sha256"]:
                    raise ValueError("The same version cannot replace update metadata")
                prepared.append((src, dst, name == metadata))
        for src, dst, metadata in prepared:
            if metadata:
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
            dst.chmod(0o644)
        for src, dst, metadata in prepared:
            if not metadata:
                continue
            temporary = dst.with_name(dst.name + ".new")
            os.replace(src, temporary)
            temporary.chmod(0o644)
            os.replace(temporary, dst)
        print(f"Published desktop update feeds {version}: {', '.join(CHANNELS)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--staging", required=True)
    parser.add_argument("--root", default="/opt/quazar/desktop-updates")
    args = parser.parse_args()
    if not re.fullmatch(r"/opt/quazar/\.desktop-updates-staging/\d+", args.staging) or args.root != "/opt/quazar/desktop-updates":
        parser.error("Unexpected publication paths")
    publish(args.staging, args.root)
    shutil.rmtree(args.staging)

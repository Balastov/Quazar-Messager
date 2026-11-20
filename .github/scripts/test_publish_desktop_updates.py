import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import io
import os

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish-desktop-updates.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "public"

    def stage(self, version, content=b"installer", suffix="one"):
        folder = self.base / suffix
        folder.mkdir()
        manifest = {"version": version, "channels": {}}
        for channel, meta in publisher.CHANNELS.items():
            source = folder / f"quazar-desktop-{channel}"
            source.mkdir()
            name = f"Quazar-{version}-{channel}." + ("exe" if channel == "win-x64" else "dmg")
            for filename, body in [(name, content), (meta, f"version: {version}\n".encode())]:
                (source / filename).write_bytes(body)
                manifest["channels"].setdefault(channel, []).append({"name": filename, "sha256": hashlib.sha256(body).hexdigest()})
        (folder / "publication.json").write_text(json.dumps(manifest))
        return folder

    def test_publishes_all_feeds_after_integrity_validation(self):
        stage = self.stage("0.20.0")
        publisher.publish(stage, self.root)
        for channel, meta in publisher.CHANNELS.items():
            self.assertEqual((self.root / channel / meta).read_text(), "version: 0.20.0\n")

    def test_corrupt_package_leaves_every_existing_feed_untouched(self):
        publisher.publish(self.stage("0.20.0"), self.root)
        stage = self.stage("0.21.0", suffix="two")
        (stage / "quazar-desktop-mac-x64" / "Quazar-0.21.0-mac-x64.dmg").write_bytes(b"corrupt")
        with self.assertRaises(ValueError): publisher.publish(stage, self.root)
        for channel, meta in publisher.CHANNELS.items():
            self.assertEqual((self.root / channel / meta).read_text(), "version: 0.20.0\n")

    def test_rejects_downgrades(self):
        publisher.publish(self.stage("0.21.0"), self.root)
        with self.assertRaises(ValueError): publisher.publish(self.stage("0.20.0", suffix="two"), self.root)

    def test_rejects_changed_installer_with_same_version(self):
        publisher.publish(self.stage("0.20.0"), self.root)
        with self.assertRaises(ValueError): publisher.publish(self.stage("0.20.0", b"changed", "two"), self.root)

    def test_an_identical_retry_is_safe(self):
        publisher.publish(self.stage("0.20.0"), self.root)
        publisher.publish(self.stage("0.20.0", suffix="two"), self.root)

    def test_rejects_symlink_installer(self):
        stage = self.stage("0.20.0")
        file = stage / "quazar-desktop-win-x64" / "Quazar-0.20.0-win-x64.exe"
        file.unlink(); file.symlink_to(self.base / "elsewhere")
        with self.assertRaises(ValueError): publisher.publish(stage, self.root)

    def test_rejects_missing_channel(self):
        stage = self.stage("0.20.0")
        manifest = json.loads((stage / "publication.json").read_text())
        del manifest["channels"]["mac-x64"]
        (stage / "publication.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError): publisher.publish(stage, self.root)

    def add_android(self, stage, version, content=b"apk"):
        manifest = json.loads((stage / "publication.json").read_text())
        source = stage / "quazar-desktop-android"
        source.mkdir()
        feed = json.dumps({"version": version, "versionCode": 1}).encode()
        for filename, body in [(f"Quazar-{version}-android.apk", content), ("latest.json", feed)]:
            (source / filename).write_bytes(body)
            manifest["channels"].setdefault("android", []).append({"name": filename, "sha256": hashlib.sha256(body).hexdigest()})
        (stage / "publication.json").write_text(json.dumps(manifest))
        return stage

    def test_publishes_the_android_channel_with_the_desktop_ones(self):
        publisher.publish(self.add_android(self.stage("1.3.0"), "1.3.0"), self.root)
        self.assertEqual(json.loads((self.root / "android" / "latest.json").read_text())["version"], "1.3.0")
        self.assertEqual((self.root / "android" / "Quazar-1.3.0-android.apk").read_bytes(), b"apk")
        # Выпуск без Android не трогает его канал.
        publisher.publish(self.stage("1.3.1", suffix="two"), self.root)
        self.assertEqual(json.loads((self.root / "android" / "latest.json").read_text())["version"], "1.3.0")

    def test_android_feed_rejects_downgrades_and_foreign_files(self):
        publisher.publish(self.add_android(self.stage("1.3.0"), "1.3.0"), self.root)
        with self.assertRaises(ValueError):
            publisher.publish(self.add_android(self.stage("1.3.0", suffix="two"), "1.2.0"), self.root)
        stage = self.add_android(self.stage("1.4.0", suffix="three"), "1.4.0")
        manifest = json.loads((stage / "publication.json").read_text())
        manifest["channels"]["android"][0]["name"] = "evil.apk"
        (stage / "quazar-desktop-android" / "Quazar-1.4.0-android.apk").rename(stage / "quazar-desktop-android" / "evil.apk")
        (stage / "publication.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError): publisher.publish(stage, self.root)
        self.assertEqual(json.loads((self.root / "android" / "latest.json").read_text())["version"], "1.3.0")

    def test_rejects_unknown_channel(self):
        stage = self.stage("0.20.0")
        manifest = json.loads((stage / "publication.json").read_text())
        manifest["channels"]["linux"] = manifest["channels"]["win-x64"]
        (stage / "publication.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError): publisher.publish(stage, self.root)

    def test_keeps_only_the_two_latest_releases(self):
        publisher.publish(self.add_android(self.stage("0.20.0"), "0.20.0"), self.root)
        (self.root / "win-x64" / "notes.txt").write_text("чужой файл")
        publisher.publish(self.stage("0.21.0", suffix="two"), self.root)
        publisher.publish(self.stage("0.22.0", suffix="three"), self.root)
        self.assertEqual(
            sorted(p.name for p in (self.root / "win-x64").iterdir()),
            ["Quazar-0.21.0-win-x64.exe", "Quazar-0.22.0-win-x64.exe", "latest.yml", "notes.txt"],
        )
        self.assertEqual((self.root / "win-x64" / "latest.yml").read_text(), "version: 0.22.0\n")
        # Канал Android не входил в новые выпуски — его единственный пакет остаётся.
        self.assertTrue((self.root / "android" / "Quazar-0.20.0-android.apk").exists())

    def test_deploy_pruning_keeps_published_and_previous_and_in_flight_packages(self):
        folder = self.root / "win-x64"
        folder.mkdir(parents=True)
        for version in ["0.18.0", "0.19.0", "0.20.0", "0.21.0"]:
            (folder / f"Quazar-{version}-win-x64.exe").write_bytes(b"x")
            (folder / f"Quazar-{version}-win-x64.exe.blockmap").write_bytes(b"x")
        (folder / "latest.yml").write_text("version: 0.20.0\n")
        # Без метаданных непонятно, что у людей сейчас, — такой канал не трогаем.
        (self.root / "mac-x64").mkdir()
        (self.root / "mac-x64" / "Quazar-0.1.0-mac-x64.zip").write_bytes(b"x")
        publisher.prune_published(self.root)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), [
            "Quazar-0.19.0-win-x64.exe", "Quazar-0.19.0-win-x64.exe.blockmap",
            "Quazar-0.20.0-win-x64.exe", "Quazar-0.20.0-win-x64.exe.blockmap",
            # 0.21.0 ещё публикуется: пакеты уже на месте, метаданные — нет.
            "Quazar-0.21.0-win-x64.exe", "Quazar-0.21.0-win-x64.exe.blockmap",
            "latest.yml",
        ])
        self.assertTrue((self.root / "mac-x64" / "Quazar-0.1.0-mac-x64.zip").exists())

    def test_removes_only_stale_interrupted_drafts(self):
        staging = self.base / "staging"
        old, fresh, current = staging / "111", staging / "222", staging / "333"
        for folder in (old, fresh, current):
            folder.mkdir(parents=True)
            (folder / "Quazar-1.0.0-win-x64.exe.part").write_bytes(b"x")
        day_ago = publisher.time.time() - 25 * 3600
        for folder in (old, current):
            os.utime(folder, (day_ago, day_ago))
        self.assertEqual(publisher.clean_staging(staging, keep=current), 1)
        self.assertEqual(sorted(p.name for p in staging.iterdir()), ["222", "333"])

    def test_publishes_across_disks(self):
        real = publisher.os.replace
        stage = self.stage("0.20.0")

        def replace(src, dst):
            if Path(src).is_relative_to(stage):
                raise OSError(publisher.errno.EXDEV, "Invalid cross-device link")
            real(src, dst)

        with mock.patch.object(publisher.os, "replace", side_effect=replace):
            publisher.publish(stage, self.root)
        for channel, meta in publisher.CHANNELS.items():
            self.assertEqual((self.root / channel / meta).read_text(), "version: 0.20.0\n")
            self.assertEqual(sorted(p.name for p in (self.root / channel).iterdir() if p.name.startswith(".")), [])
        self.assertEqual(sorted(p.name for p in (stage / "quazar-desktop-win-x64").iterdir()), [])

    def downloadable(self):
        stage = self.stage("0.20.0")
        manifest = json.loads((stage / "publication.json").read_text())
        manifest["download_base"] = "https://github.com/Balastov/Quazar-Messager/releases/download/desktop-v0.20.0-pilot.1"
        payloads = {}
        for channel, entries in manifest["channels"].items():
            for entry in entries:
                entry["asset"] = f"latest-{channel}.yml" if entry["name"].endswith('.yml') else entry["name"]
                file = stage / f"quazar-desktop-{channel}" / entry["name"]
                body = file.read_bytes(); payloads[entry["asset"]] = body
                entry["size"] = len(body); file.unlink()
        (stage / "publication.json").write_text(json.dumps(manifest))
        return stage, payloads

    def test_downloads_and_resumes_verified_public_assets_before_publication(self):
        stage, payloads = self.downloadable()
        partial = stage / "quazar-desktop-win-x64" / "Quazar-0.20.0-win-x64.exe.part"
        partial.write_bytes(b"inst")
        def request(req, **_):
            body = payloads[req.full_url.rsplit('/', 1)[1]]
            offset = 4 if req.get_header('Range') else 0
            response = io.BytesIO(body[offset:]); response.status = 206 if offset else 200
            response.headers = {"Content-Range": f"bytes {offset}-{len(body)-1}/{len(body)}"} if offset else {}
            return response
        with mock.patch.object(publisher, "urlopen", side_effect=request): publisher.publish(stage, self.root)
        self.assertEqual((self.root / 'win-x64' / 'Quazar-0.20.0-win-x64.exe').read_bytes(), b"installer")

    def test_corrupt_remote_download_is_never_published(self):
        stage, payloads = self.downloadable()
        def request(req, **_):
            response = io.BytesIO(b"corrupt"); response.status = 200; response.headers = {}
            return response
        with mock.patch.object(publisher, "urlopen", side_effect=request):
            with self.assertRaises(ValueError): publisher.publish(stage, self.root)
        self.assertFalse(self.root.exists())


if __name__ == "__main__": unittest.main()

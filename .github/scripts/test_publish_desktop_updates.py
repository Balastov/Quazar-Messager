import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__": unittest.main()

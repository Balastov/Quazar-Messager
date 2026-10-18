"""Стикерпаки: манифесты, каталог для клиентов, раздача анимаций."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import httpx
from starlette.applications import Starlette
from starlette.routing import Mount

from app.api import stickers as api
from app.core import stickers


class TestBundledPacks(unittest.TestCase):
    def setUp(self):
        stickers.all_packs.cache_clear()

    def test_noto_is_installed_for_everyone(self):
        packs = stickers.packs_for_user("anyone")
        self.assertEqual(packs[0].id, "noto")
        noto = packs[0]
        self.assertTrue(noto.default)
        self.assertEqual(noto.license, "CC BY 4.0")
        self.assertGreaterEqual(len(noto.stickers), 50)
        self.assertEqual(len({s.id for s in noto.stickers}), len(noto.stickers))
        self.assertIn("😂", [s.emoji for s in noto.stickers])

    def test_every_sticker_is_a_lottie_animation(self):
        for pack in stickers.all_packs():
            for s in pack.stickers:
                data = json.loads((stickers.STICKERS_DIR / pack.id / s.file).read_text(encoding="utf-8"))
                self.assertIsInstance(data.get("layers"), list, f"{pack.id}/{s.file}")

    def test_catalog_urls_carry_the_pack_version(self):
        out = api.pack_out(stickers.packs_for_user("u")[0])
        first = out.stickers[0]
        self.assertEqual(first.url, f"/stickers/files/noto/{first.id}.json?v={out.version}")


class TestPackLoading(unittest.TestCase):
    def make_pack(self, root: Path, pack_id: str, *, default=False, files=("a",), manifest_id=None):
        d = root / pack_id
        d.mkdir()
        for f in files:
            (d / f"{f}.json").write_text('{"fr":30,"layers":[]}')
        manifest = {
            "id": manifest_id or pack_id,
            "title": pack_id.title(),
            "default": default,
            "stickers": [{"id": "a", "emoji": "🙂", "file": "a.json"}],
        }
        (d / "manifest.json").write_text(json.dumps(manifest))

    def test_broken_packs_are_skipped_and_defaults_come_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_pack(root, "zeta", default=True)
            self.make_pack(root, "alpha")
            self.make_pack(root, "nofile", files=())
            self.make_pack(root, "renamed", manifest_id="other")
            with mock.patch.object(stickers, "STICKERS_DIR", root):
                stickers.all_packs.cache_clear()
                self.addCleanup(stickers.all_packs.cache_clear)
                self.assertEqual([p.id for p in stickers.all_packs()], ["zeta", "alpha"])
                self.assertEqual([p.id for p in stickers.packs_for_user("u")], ["zeta"])


class TestEndpoints(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        stickers.all_packs.cache_clear()
        app = Starlette(routes=[Mount(api.FILES_PATH, api.StickerFiles(directory=str(stickers.STICKERS_DIR)))])
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def test_my_packs(self):
        out = await api.my_packs(SimpleNamespace(id="u1"))
        self.assertEqual([p.id for p in out], ["noto"])

    async def test_files_are_cached_forever(self):
        url = (await api.my_packs(SimpleNamespace(id="u1")))[0].stickers[0].url
        resp = await self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("immutable", resp.headers["cache-control"])
        self.assertIn("layers", resp.json())

    async def test_no_path_traversal(self):
        for path in ("/stickers/files/../app/main.py", "/stickers/files/%2e%2e/app/main.py"):
            resp = await self.client.get(path)
            self.assertEqual(resp.status_code, 404, path)


if __name__ == "__main__":
    unittest.main()

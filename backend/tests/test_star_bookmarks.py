"""Закладки Спутника: ссылки и файлы, права, порядок, удаление вместе с файлом.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import tempfile
import unittest
from unittest import mock

from pydantic import ValidationError

from app.api import star_bookmarks as bm
from app.api import star_files as files_api
from app.api import stars as api
from app.core.config import settings
from app.schemas.star import SendStarMessage, UpdateChannel
from tests.stars_base import StarsTestBase
from tests.test_star_files_notify import FakeRequest


class BookmarkBodyTest(unittest.TestCase):
    def test_link_or_file(self):
        self.assertEqual(bm.BookmarkBody(title=" Вики  команды ", url="wiki.example.com/a").url, "https://wiki.example.com/a")
        self.assertEqual(bm.BookmarkBody(title="x", url="http://a.ru").title, "x")
        for bad in (
            {"title": "x"},
            {"title": "x", "url": "https://a.ru", "file_id": "f"},
            {"title": "x", "url": "javascript:alert(1)"},
            {"title": "x", "url": "ftp://a.ru"},
            {"title": "  ", "url": "https://a.ru"},
        ):
            with self.assertRaises(ValidationError, msg=bad):
                bm.BookmarkBody(**bad)


class StarBookmarksTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        media = tempfile.mkdtemp()
        for name, value in (("MEDIA_ROOT", media), ("MEDIA_MIN_FREE_MB", 0)):
            patcher = mock.patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")

    async def add(self, user="alice", **body):
        return await self.call(bm.add_bookmark, self.star.id, self.sat.id, bm.BookmarkBody(**body), user=user)

    async def listing(self, user="bob"):
        return await self.call(bm.list_bookmarks, self.star.id, self.sat.id, user=user)

    async def test_add_list_and_broadcast(self):
        link = await self.add(title="Вики", url="https://wiki.example.com", emoji="📘")
        self.assertEqual((link.title, link.emoji, link.file), ("Вики", "📘", None))
        self.assertEqual([b.id for b in await self.listing()], [link.id])
        events = [e for _, e in self.events if e.get("type") == "star_bookmarks"]
        self.assertEqual(events[-1]["bookmarks"][0]["url"], "https://wiki.example.com")

    async def test_file_bookmark_follows_the_file(self):
        up = await self.call(
            files_api.upload_file, self.star.id, self.sat.id, FakeRequest(b"%PDF-1.4 x"), user="alice", name="Регламент.pdf"
        )
        # Не отправленный файл в закладку не годится.
        await self.expect_error(422, bm.add_bookmark, self.star.id, self.sat.id,
                                bm.BookmarkBody(title="Регламент", file_id=up.id), user="alice")
        msg = await self.call(api.send_message, self.star.id, self.sat.id, SendStarMessage(file_id=up.id), user="alice")
        mark = await self.add(title="Регламент", file_id=up.id)
        self.assertEqual(mark.file.name, "Регламент.pdf")
        await self.call(api.delete_message, self.star.id, self.sat.id, msg.id, user="alice")
        self.assertEqual(await self.listing(), [])

    async def test_permissions(self):
        mark = await self.add(title="Моя", url="https://a.ru")
        body = bm.BookmarkBody(title="Чужая", url="https://b.ru")
        await self.expect_error(403, bm.update_bookmark, self.star.id, self.sat.id, mark.id, body, user="bob")
        await self.expect_error(403, bm.delete_bookmark, self.star.id, self.sat.id, mark.id, user="bob")
        out = await self.call(bm.update_bookmark, self.star.id, self.sat.id, mark.id, body, user="mod")
        self.assertEqual(out.title, "Чужая")
        await self.call(bm.delete_bookmark, self.star.id, self.sat.id, mark.id, user="alice")
        # Канал объявлений: добавляют модераторы и выше.
        await self.call(api.update_channel, self.star.id, self.sat.id, UpdateChannel(announcement=True), user="owner")
        await self.expect_error(403, bm.add_bookmark, self.star.id, self.sat.id, body, user="bob")
        await self.add(user="mod", title="Ок", url="https://c.ru")
        # Чужие Звёзды не видны.
        await self.expect_error(404, bm.list_bookmarks, self.star.id, self.sat.id, user="carol")

    async def test_reorder_and_limit(self):
        a = await self.add(title="A", url="https://a.ru")
        b = await self.add(title="B", url="https://b.ru")
        await self.expect_error(403, bm.reorder_bookmarks, self.star.id, self.sat.id, bm.OrderBody(ids=[b.id, a.id]), user="bob")
        out = await self.call(bm.reorder_bookmarks, self.star.id, self.sat.id, bm.OrderBody(ids=[b.id]), user="admin")
        self.assertEqual([x.title for x in out], ["B", "A"])
        with mock.patch.object(bm, "BOOKMARK_LIMIT", 2):
            await self.expect_error(409, bm.add_bookmark, self.star.id, self.sat.id,
                                    bm.BookmarkBody(title="C", url="https://c.ru"), user="alice")


if __name__ == "__main__":
    unittest.main()

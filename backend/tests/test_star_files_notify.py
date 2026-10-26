"""Файлы Спутников, @упоминания и уровни уведомлений (кому уходит push).

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from pydantic import ValidationError
from sqlalchemy import update

from app.api import notify as notify_api
from app.api import star_files as files_api
from app.api import stars as api
from app.core import notify, star_files
from app.core.config import settings
from app.models.user import User
from app.schemas.star import EditStarMessage, SendStarMessage
from tests.stars_base import StarsTestBase


class FakeRequest:
    def __init__(self, body: bytes, content_type: str = "application/pdf"):
        self.body = body
        self.headers = {"content-length": str(len(body)), "content-type": content_type}

    async def stream(self):
        for i in range(0, len(self.body), 4096):
            yield self.body[i : i + 4096]


class ParseMentionsTest(unittest.TestCase):
    def test_names_case_and_punctuation(self):
        names = {"alice": "a", "bob.k": "b", "иван": "i"}
        ids, everyone = notify.parse_mentions("@Alice, @bob.k. и @Иван! почта x@alice.ru @nobody", names)
        self.assertEqual((ids, everyone), ({"a", "b", "i"}, False))
        self.assertEqual(notify.parse_mentions("@все сюда", names), (set(), True))


class StarFilesNotifyTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        media = tempfile.mkdtemp()
        for name, value in (("MEDIA_ROOT", media), ("MEDIA_MIN_FREE_MB", 0)):
            patcher = mock.patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.pushes: list[tuple[list[str], dict]] = []
        patcher = mock.patch.object(notify, "push_later", lambda ids, payload: self.pushes.append((ids, payload)))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def upload(self, body: bytes, name="Отчёт.pdf", user="alice", **kw):
        return await self.call(
            files_api.upload_file, self.star.id, self.sat.id, FakeRequest(body, **kw), user=user, name=name
        )

    async def say(self, text="", user="alice", **kwargs):
        return await self.call(
            api.send_message, self.star.id, self.sat.id, SendStarMessage(text=text, **kwargs), user=user
        )

    async def files(self, user="bob", q="", kind="all"):
        return await self.call(
            files_api.list_files, self.star.id, user=user, q=q, channel_id=None, kind=kind, before=None, limit=50
        )

    def pushed_to(self) -> set[str]:
        return {uid for ids, _ in self.pushes for uid in ids}

    # --- Файлы ---

    async def test_file_message_listing_search_and_download(self):
        up = await self.upload(b"%PDF-1.7 hello", name="../../Квартальный отчёт.pdf")
        self.assertEqual((up.name, up.mime, up.size), ("Квартальный отчёт.pdf", "application/pdf", 14))
        # Пока не отправлен — другим не виден и в список не попадает.
        await self.expect_error(404, files_api.download_file, self.star.id, up.id, user="bob")
        listed = await self.files()
        self.assertEqual(listed.files, [])

        msg = await self.say(file_id=up.id)
        self.assertEqual((msg.kind, msg.text, msg.file.name), ("file", "", "Квартальный отчёт.pdf"))
        await self.say("картинка", file_id=(await self.upload(b"\x89PNG....", name="shot.png", content_type="image/png")).id)

        found = await self.files(q="КВАРТАЛ")
        self.assertEqual([f.name for f in found.files], ["Квартальный отчёт.pdf"])
        self.assertEqual(found.used_bytes, 14 + 8)
        images = await self.files(kind="images")
        self.assertEqual([f.name for f in images.files], ["shot.png"])

        pdf = await self.call(files_api.download_file, self.star.id, up.id, user="bob")
        self.assertEqual(pdf.media_type, "application/octet-stream")  # не открывается как страница
        self.assertIn("attachment", pdf.headers["content-disposition"])
        png = await self.call(files_api.download_file, self.star.id, images.files[0].id, user="bob")
        self.assertEqual(png.media_type, "image/png")

        # Удалили сообщение — файл пропал с диска.
        path = star_files.file_path(up.id)
        self.assertTrue(path.is_file())
        await self.call(api.delete_message, self.star.id, self.sat.id, msg.id, user="alice")
        self.assertFalse(path.is_file())

    async def test_file_rules(self):
        with self.assertRaises(ValidationError):
            SendStarMessage(text="  ")
        up = await self.upload(b"data")
        await self.expect_error(422, api.send_message, self.star.id, self.sat.id, SendStarMessage(file_id=up.id), user="bob")
        await self.say(file_id=up.id)
        await self.expect_error(422, api.send_message, self.star.id, self.sat.id, SendStarMessage(file_id=up.id), user="alice")
        await self.expect_error(422, files_api.upload_file, self.star.id, self.sat.id, FakeRequest(b""), user="alice", name="x")
        with mock.patch.object(settings, "STAR_FILES_QUOTA_MB", 0):
            await self.expect_error(507, files_api.upload_file, self.star.id, self.sat.id, FakeRequest(b"x"), user="alice", name="x")

    # --- Упоминания и push ---

    async def test_mentions_are_stored_and_staff_only_for_everyone(self):
        msg = await self.say("@bob глянь, и @alice тоже, @Carol тут нет")
        self.assertEqual(msg.mentions, [self.uid("bob")])  # себя не упоминаем, carol не в Звезде
        self.assertFalse((await self.say("@все привет")).mention_all)
        self.assertTrue((await self.say("@все планёрка", user="mod")).mention_all)
        edited = await self.call(
            api.edit_message, self.star.id, self.sat.id, msg.id, EditStarMessage(text="@admin глянь"), user="alice"
        )
        self.assertEqual(edited.mentions, [self.uid("admin")])

    async def test_push_follows_levels_and_mentions(self):
        await self.say("просто так")
        self.assertEqual(self.pushed_to(), set())  # по умолчанию в Звёздах — только упоминания

        self.pushes.clear()
        await self.say("@bob срочно")
        self.assertEqual(self.pushed_to(), {self.uid("bob")})
        self.assertIn("alice · #", self.pushes[0][1]["title"])

        # bob — «всё», owner — тишина на час, admin — «ничего» в этом Спутнике.
        await self.call(notify_api.set_notify, "star", self.star.id, notify_api.NotifyBody(level="all"), user="bob")
        await self.call(notify_api.set_notify, "star", self.star.id, notify_api.NotifyBody(
            level="all", muted_until=datetime.now(timezone.utc) + timedelta(hours=1)), user="owner")
        await self.call(notify_api.set_notify, "channel", self.sat.id, notify_api.NotifyBody(level="none"), user="admin")
        self.pushes.clear()
        await self.say("@все сбор", user="mod")
        self.assertEqual(self.pushed_to(), {self.uid("bob"), self.uid("alice")})

        # Ответ мне — как упоминание; «не беспокоить» и открытое приложение — без push.
        root = await self.say("вопрос", user="mod")
        self.pushes.clear()
        await self.say("ответ", reply_to_id=root.id)
        self.assertEqual(self.pushed_to(), {self.uid("mod"), self.uid("bob")})
        # Ветка: только автор корня (и упомянутые), bob с «Все сообщения» — нет.
        self.pushes.clear()
        await self.say("в ветке", thread_id=root.id)
        self.assertEqual(self.pushed_to(), {self.uid("mod")})
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.uid("mod")).values(manual_status="dnd"))
            await db.commit()
        self.pushes.clear()
        with mock.patch.dict(notify.manager.user_connections, {self.uid("bob"): {object()}}):
            await self.say("ответ 2", reply_to_id=root.id)
        self.assertEqual(self.pushed_to(), set())

    async def test_notify_settings_api(self):
        await self.expect_error(404, notify_api.set_notify, "star", self.star.id, notify_api.NotifyBody(level="all"), user="carol")
        await self.expect_error(404, notify_api.set_notify, "chat", "no-such-chat", notify_api.NotifyBody(level="none"), user="alice")
        out = await self.call(notify_api.set_notify, "channel", self.sat.id, notify_api.NotifyBody(level="all"), user="alice")
        self.assertEqual(out.level, "all")
        self.assertEqual(self.events[-1], (self.uid("alice"), {"type": "notify_setting", "scope": "channel",
                                                               "target_id": self.sat.id, "level": "all", "muted_until": None}))
        # Прошедшая тишина не сохраняется; пустая настройка удаляется.
        past = notify_api.NotifyBody(muted_until=datetime.now(timezone.utc) - timedelta(minutes=1))
        await self.call(notify_api.set_notify, "channel", self.sat.id, past, user="alice")
        self.assertEqual(await self.call(notify_api.my_notify_settings, user="alice"), [])

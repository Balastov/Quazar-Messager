"""Общие Спутники между Звёздами: подключение по коду, доступ гостей, рассылка, ограничения.

Звезда-хозяин: owner, admin, mod, alice, bob. Гостевая Звезда: carol (владелец) и bob
(состоит в обеих). Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import tempfile
from datetime import datetime, timedelta, timezone
from unittest import mock

from sqlalchemy import update

from app.api import pins as pins_api
from app.api import search as search_api
from app.api import star_bookmarks as bm
from app.api import star_files as files_api
from app.api import star_notes as notes
from app.api import star_play as play
from app.api import star_shares as sh
from app.api import stars as api
from app.core.config import settings
from app.models.star import StarShareInvite
from app.schemas.star import CreateChannel, SendStarMessage, UpdateChannel
from tests.stars_base import StarsTestBase
from tests.test_star_files_notify import FakeRequest


class StarSharesTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        media = tempfile.mkdtemp()
        for name, value in (("MEDIA_ROOT", media), ("MEDIA_MIN_FREE_MB", 0)):
            patcher = mock.patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.home = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.home.channels if c.kind == "satellite")
        self.secret = await self.call(
            api.create_channel, self.home.id, CreateChannel(kind="satellite", name="секреты"), user="owner"
        )
        self.guest = await self.make_star(kind="work", user="carol", name="Партнёр")
        await self.join(self.guest.id, "bob", inviter="carol")

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def share(self) -> None:
        invite = await self.call(sh.create_share_invite, self.home.id, self.sat.id, user="owner")
        await self.call(sh.accept_invite, invite.code, sh.AcceptBody(star_id=self.guest.id), user="carol")

    async def say(self, star_id: str, text: str, user: str, channel_id: str | None = None):
        return await self.call(
            api.send_message, star_id, channel_id or self.sat.id, SendStarMessage(text=text), user=user
        )

    async def test_invite_and_detail(self):
        preview = await self.call(sh.preview_invite, (await self.call(
            sh.create_share_invite, self.home.id, self.sat.id, user="owner")).code, user="carol")
        self.assertEqual((preview.channel_name, preview.star.name), (self.sat.name, "Звезда"))
        await self.share()
        guest = await self.call(api.get_star, self.guest.id, user="carol")
        shared = [c for c in guest.channels if c.id == self.sat.id]
        self.assertEqual(len(shared), 1)
        self.assertEqual((shared[0].star_id, shared[0].shared_from.name), (self.guest.id, "Звезда"))
        # Другие каналы хозяина гостям не видны.
        self.assertNotIn(self.secret.id, [c.id for c in guest.channels])
        home = await self.call(api.get_star, self.home.id, user="alice")
        self.assertEqual([s.name for s in next(c for c in home.channels if c.id == self.sat.id).shared_with], ["Партнёр"])

    async def test_invite_rules(self):
        invite = await self.call(sh.create_share_invite, self.home.id, self.sat.id, user="owner")
        # Код выпускают и принимают те, у кого право «Каналы».
        await self.expect_error(403, sh.create_share_invite, self.home.id, self.sat.id, user="alice")
        await self.expect_error(403, sh.accept_invite, invite.code, sh.AcceptBody(star_id=self.home.id), user="alice")
        await self.expect_error(409, sh.accept_invite, invite.code, sh.AcceptBody(star_id=self.home.id), user="owner")
        await self.call(sh.accept_invite, invite.code, sh.AcceptBody(star_id=self.guest.id), user="carol")
        # Одноразовый.
        await self.expect_error(404, sh.accept_invite, invite.code, sh.AcceptBody(star_id=self.guest.id), user="carol")
        late = await self.call(sh.create_share_invite, self.home.id, self.sat.id, user="owner")
        async with self.Session() as db:
            await db.execute(update(StarShareInvite).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
            await db.commit()
        await self.expect_error(404, sh.preview_invite, late.code, user="carol")
        # Планету общей не сделать.
        planet = next(c for c in self.home.channels if c.kind == "planet")
        await self.expect_error(400, sh.create_share_invite, self.home.id, planet.id, user="owner")

    async def test_guest_reads_and_writes_only_the_shared_channel(self):
        await self.expect_error(404, api.list_messages, self.guest.id, self.sat.id, user="carol", limit=50, before_id=None)
        await self.share()
        await self.say(self.home.id, "привет, партнёры", user="alice")
        mine = await self.say(self.guest.id, "привет, @alice", user="carol")
        self.assertEqual(mine.star_id, self.guest.id)
        self.assertEqual(mine.mentions, [self.uid("alice")])
        seen = await self.call(api.list_messages, self.guest.id, self.sat.id, user="carol", limit=50, before_id=None)
        self.assertEqual([m.text for m in seen], ["привет, партнёры", "привет, @alice"])
        self.assertTrue(all(m.star_id == self.guest.id for m in seen))
        home_view = await self.call(api.list_messages, self.home.id, self.sat.id, user="alice", limit=50, before_id=None)
        self.assertEqual(home_view[-1].star_id, self.home.id)
        # Ни Звезда-хозяин, ни её другие каналы гостю не открываются.
        await self.expect_error(404, api.get_star, self.home.id, user="carol")
        await self.expect_error(404, api.list_messages, self.guest.id, self.secret.id, user="carol", limit=50, before_id=None)
        await self.expect_error(404, api.send_message, self.guest.id, self.secret.id, SendStarMessage(text="x"), user="carol")

    async def test_events_reach_both_stars_once(self):
        await self.share()
        self.events.clear()
        await self.say(self.guest.id, "событие", user="carol")
        got = {uid: e for uid, e in self.events if e.get("type") == "star_message"}
        recipients = [uid for uid, e in self.events if e.get("type") == "star_message"]
        self.assertEqual(len(recipients), len(set(recipients)))  # bob — один раз
        self.assertEqual(got[self.uid("alice")]["star_id"], self.home.id)
        self.assertEqual(got[self.uid("alice")]["message"]["star_id"], self.home.id)
        self.assertEqual(got[self.uid("carol")]["star_id"], self.guest.id)
        self.assertEqual(got[self.uid("carol")]["message"]["star_id"], self.guest.id)
        self.assertEqual(got[self.uid("bob")]["star_id"], self.home.id)

    async def test_guest_staff_are_members_here(self):
        await self.share()
        msg = await self.say(self.home.id, "сообщение хозяина", user="alice")
        await self.expect_error(403, api.delete_message, self.guest.id, self.sat.id, msg.id, user="carol")
        await self.expect_error(403, pins_api.pin_star_message, self.guest.id, self.sat.id, msg.id, user="carol")
        # Настройки канала — только у хозяина: для гостя этого канала «нет».
        await self.expect_error(404, api.update_channel, self.guest.id, self.sat.id, UpdateChannel(name="мой"), user="carol")
        await self.expect_error(404, api.delete_channel, self.guest.id, self.sat.id, user="carol")
        # @все гостевого владельца — просто текст.
        self.assertFalse((await self.say(self.guest.id, "@все сюда", user="carol")).mention_all)
        # Своё удалить можно, а модератор хозяина удаляет и чужое.
        own = await self.say(self.guest.id, "моё", user="carol")
        await self.call(api.delete_message, self.guest.id, self.sat.id, own.id, user="carol")
        other = await self.say(self.guest.id, "ещё", user="carol")
        await self.call(api.delete_message, self.home.id, self.sat.id, other.id, user="mod")
        # Опросы и сборы в общем Спутнике недоступны.
        await self.expect_error(409, play.create_poll, self.home.id, self.sat.id,
                                play.PollBody(question="?", options=["a", "b"]), user="alice")

    async def test_files_search_notes_bookmarks(self):
        await self.share()
        up = await self.call(
            files_api.upload_file, self.guest.id, self.sat.id, FakeRequest(b"%PDF-1.4 x"), user="carol", name="Договор.pdf"
        )
        await self.call(api.send_message, self.guest.id, self.sat.id, SendStarMessage(file_id=up.id), user="carol")
        # Файл живёт у хозяина, скачивают обе стороны по своим адресам.
        await self.call(files_api.download_file, self.home.id, up.id, user="alice")
        await self.call(files_api.download_file, self.guest.id, up.id, user="carol")
        listed = await self.call(files_api.list_files, self.guest.id, user="carol", q="", channel_id=None,
                                 kind="all", before=None, limit=50)
        self.assertEqual([f.name for f in listed.files], ["Договор.pdf"])
        # Файл другого канала хозяина гостю не отдаётся.
        secret = await self.call(
            files_api.upload_file, self.home.id, self.secret.id, FakeRequest(b"%PDF-1.4 y"), user="alice", name="Секрет.pdf"
        )
        await self.call(api.send_message, self.home.id, self.secret.id, SendStarMessage(file_id=secret.id), user="alice")
        await self.expect_error(404, files_api.download_file, self.guest.id, secret.id, user="carol")
        # Поиск гостя — только общий Спутник.
        await self.say(self.home.id, "договор подписан", user="alice", channel_id=self.secret.id)
        await self.say(self.home.id, "договор согласован", user="alice")
        found = await self.call(search_api.search_messages, self.guest.id, user="carol", q="договор",
                                channel_id=None, before=None, limit=30)
        # Сообщение с «Договор.pdf» — тоже из общего Спутника; «договор подписан» из секретного — нет.
        self.assertEqual([m.text for m in found], ["договор согласован", ""])
        self.assertTrue(all(m.channel_id == self.sat.id for m in found))
        # Заметки и закладки — общие; закладка-файл — только из самого Спутника.
        saved = await self.call(notes.save_notes, self.guest.id, self.sat.id,
                                notes.SaveNote(text="# Общие правила", base_version=0), user="carol")
        self.assertEqual(saved.version, 1)
        self.assertEqual((await self.call(notes.get_notes, self.home.id, self.sat.id, user="alice")).text, "# Общие правила")
        await self.call(bm.add_bookmark, self.guest.id, self.sat.id, bm.BookmarkBody(title="Договор", file_id=up.id), user="carol")
        await self.expect_error(422, bm.add_bookmark, self.home.id, self.sat.id,
                                bm.BookmarkBody(title="Секрет", file_id=secret.id), user="alice")
        await self.expect_error(403, bm.reorder_bookmarks, self.guest.id, self.sat.id, bm.OrderBody(ids=[]), user="carol")
        self.assertEqual(len(await self.call(bm.list_bookmarks, self.home.id, self.sat.id, user="alice")), 1)

    async def test_unshare_by_host_or_guest(self):
        await self.share()
        await self.expect_error(403, sh.remove_share, self.guest.id, self.sat.id, self.guest.id, user="bob")
        await self.call(sh.remove_share, self.guest.id, self.sat.id, self.guest.id, user="carol")
        await self.expect_error(404, api.list_messages, self.guest.id, self.sat.id, user="carol", limit=50, before_id=None)
        deleted = [e for uid, e in self.events if uid == self.uid("carol") and e.get("type") == "star_channel_deleted"]
        self.assertEqual(deleted[-1]["star_id"], self.guest.id)
        await self.share()
        await self.call(sh.remove_share, self.home.id, self.sat.id, self.guest.id, user="owner")
        self.assertEqual(await self.call(sh.list_shares, self.home.id, self.sat.id, user="owner"), [])

    async def test_deleting_the_channel_tells_guests(self):
        await self.share()
        self.events.clear()
        await self.call(api.delete_channel, self.home.id, self.sat.id, user="owner")
        carol = [e for uid, e in self.events if uid == self.uid("carol") and e.get("type") == "star_channel_deleted"]
        self.assertEqual(carol[-1]["star_id"], self.guest.id)

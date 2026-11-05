"""Release news: registered recipients, concurrency, restart safety and read-only inboxes."""
import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from sqlalchemy import func, select, text

from app.api import attachments, chats, later, messages
from app.core import news, support
from app.core.release_notes import parse_release_notes
from app.models.chat import Chat
from app.models.message import Message
from app.models.news import NewsDelivery, NewsInbox, NewsRelease
from app.models.notify import NotifySetting
from app.models.user import User
from app.schemas.chat import SetChatTtl
from app.schemas.message import SendMessage
from tests.stars_base import StarsTestBase


def notes(version="0.20.4", change="Фото профиля сразу обновляется после замены."):
    return parse_release_notes({"version": version, "title": "Что нового", "changes": [change]}, version)


class ReleaseNotesTest(unittest.TestCase):
    def test_message_contains_version_and_user_facing_bullets(self):
        self.assertEqual(notes().message, "Quazar 0.20.4 · Что нового\n\n• Фото профиля сразу обновляется после замены.")

    def test_incomplete_or_wrong_version_notes_are_rejected(self):
        for raw in [None, {}, {"version": "0.20.4", "title": "x", "changes": []},
                    {"version": "0.20.3", "title": "x", "changes": ["y"]},
                    {"version": "0.20.4", "title": "x", "changes": [" "]},
                    {"version": "0.20.4", "title": "x", "changes": ["a\nb"]}]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_release_notes(raw, "0.20.4")

    def test_committed_notes_match_app_version(self):
        root = Path(__file__).resolve().parents[2]
        version = json.loads((root / "web/package.json").read_text())["version"]
        parse_release_notes(json.loads((root / "deploy/release-notes.json").read_text()), version)


class NewsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.Session() as db:
            self.bot_id = (await news.bot_user(db)).id
        patcher = mock.patch("app.core.notify.push_later")
        self.push = patcher.start()
        self.addCleanup(patcher.stop)

    async def enqueue(self, value=None):
        async with self.Session() as db:
            return await news.enqueue_release(db, value or notes())

    async def drain(self):
        async with self.Session() as db:
            return await news.send_pending(db)

    async def count(self, model):
        async with self.Session() as db:
            return (await db.execute(select(func.count()).select_from(model))).scalar_one()

    async def inbox(self, name="alice"):
        async with self.Session() as db:
            return await db.get(NewsInbox, self.users[name].id)

    async def test_support_and_news_are_distinct_official_accounts(self):
        async with self.Session() as db:
            admin = await support.bot_user(db)
            bot = await news.bot_user(db)
            self.assertNotEqual(admin.id, bot.id)
            self.assertEqual(admin.username, "Quazar_Admin_bot")
            self.assertEqual(bot.username, "Quazar_news_bot")
            self.assertTrue(bot.is_official)
            self.assertFalse(bot.phone_discoverable)
            self.assertIsNone(bot.password_hash)

    async def test_all_registered_people_get_private_inboxes_and_bots_are_excluded(self):
        async with self.Session() as db:
            await support.bot_user(db)
            db.add(User(username="technical", phone="bot:legacy", password_hash=None))
            (await db.get(User, self.users["carol"].id)).blocked_at = datetime.now(timezone.utc)
            await db.commit()
        self.assertEqual(await self.enqueue(), 6)
        self.assertEqual(await self.drain(), 6)
        self.assertEqual(await self.count(NewsInbox), 6)
        self.assertEqual(await self.count(Message), 6)
        self.assertNotIn(self.users["carol"].id, [uid for uid, _ in self.events])
        pushed = {uid for call in self.push.call_args_list for uid in call.args[0]}
        self.assertEqual(pushed, {u.id for name, u in self.users.items() if name != "carol"})
        async with self.Session() as db:
            for message in (await db.execute(select(Message))).scalars():
                self.assertEqual(message.sender_id, self.bot_id)
                self.assertEqual(message.payload, notes().message)

    async def test_redeploy_never_duplicates_or_adds_new_users_to_old_release(self):
        await self.enqueue()
        await self.drain()
        async with self.Session() as db:
            db.add(User(username="new_person", phone="+79110000000", password_hash="x"))
            await db.commit()
        self.assertEqual(await self.enqueue(), 0)
        self.assertEqual(await self.drain(), 0)
        self.assertEqual(await self.count(Message), 6)
        self.assertEqual(await self.count(NewsDelivery), 6)

    async def test_legacy_people_without_a_phone_are_also_recipients(self):
        async with self.Session() as db:
            await db.execute(text("ALTER TABLE users ALTER COLUMN phone DROP NOT NULL"))
            person = User(username="legacy_person", phone=None, password_hash="x")
            db.add(person)
            await db.commit()
            person_id = person.id
        self.assertEqual(await self.enqueue(), 7)
        await self.drain()
        async with self.Session() as db:
            self.assertIsNotNone(await db.get(NewsInbox, person_id))

    async def test_same_version_cannot_be_rewritten(self):
        await self.enqueue()
        with self.assertRaises(ValueError):
            await self.enqueue(notes(change="Другой текст"))

    async def test_new_versions_reuse_the_same_inbox(self):
        await self.enqueue()
        await self.drain()
        await self.enqueue(notes("0.20.5"))
        await self.drain()
        self.assertEqual(await self.count(NewsInbox), 6)
        self.assertEqual(await self.count(Message), 12)

    async def test_historical_versions_and_rollbacks_do_not_start_broadcasts(self):
        self.assertEqual(await self.enqueue(notes("0.20.3")), 0)
        self.assertEqual(await self.count(NewsRelease), 0)
        self.assertEqual(await self.enqueue(notes("0.20.6")), 6)
        self.assertEqual(await self.enqueue(notes("0.20.5")), 0)

    async def test_parallel_deploys_snapshot_recipients_once(self):
        self.assertEqual(sorted(await asyncio.gather(self.enqueue(), self.enqueue())), [0, 6])
        self.assertEqual(await self.count(NewsDelivery), 6)

    async def test_parallel_workers_cannot_create_duplicate_messages(self):
        await self.enqueue()
        await asyncio.gather(self.drain(), self.drain())
        await self.drain()
        self.assertEqual(await self.count(Message), 6)
        self.assertEqual(await self.count(NewsInbox), 6)

    async def test_restart_after_message_commit_reuses_its_id(self):
        await self.enqueue()
        with mock.patch("app.api.messages.publish_message", side_effect=RuntimeError("network failure")):
            with self.assertRaises(RuntimeError):
                await self.drain()
        self.assertEqual(await self.count(Message), 1)
        await self.drain()
        self.assertEqual(await self.count(Message), 6)

    async def test_news_are_read_only_and_other_inboxes_are_private(self):
        await self.enqueue()
        await self.drain()
        mine, other = await self.inbox(), await self.inbox("bob")
        await self.expect_error(403, messages.send_message, mine.chat_id, SendMessage(payload="reply"), user="alice")
        await self.expect_error(403, attachments.upload_attachment, mine.chat_id, request=None, user="alice")
        await self.expect_error(403, later.schedule_message, mine.chat_id,
            later.ScheduleBody(payload="later", send_at=datetime.now(timezone.utc) + timedelta(hours=1)), user="alice")
        await self.expect_error(422, chats.set_chat_ttl, mine.chat_id, SetChatTtl(ttl_seconds=3600), user="alice")
        await self.expect_error(403, messages.get_messages, other.chat_id, user="alice", limit=50, before_id=None)
        listed = await self.call(chats.list_chats, user="alice")
        self.assertEqual([(c.type, c.name, c.unread_count) for c in listed], [("news", "Quazar_news_bot", 1)])

    async def test_muting_suppresses_push_but_does_not_remove_news(self):
        await self.enqueue()
        await self.drain()
        mine = await self.inbox()
        async with self.Session() as db:
            db.add(NotifySetting(user_id=self.users["alice"].id, scope="chat", target_id=mine.chat_id, level="none"))
            await db.commit()
        self.push.reset_mock()
        await self.enqueue(notes("0.20.5"))
        await self.drain()
        pushed = {uid for call in self.push.call_args_list for uid in call.args[0]}
        self.assertNotIn(self.users["alice"].id, pushed)
        async with self.Session() as db:
            count = (await db.execute(select(func.count()).select_from(Message).where(Message.chat_id == mine.chat_id))).scalar_one()
        self.assertEqual(count, 2)

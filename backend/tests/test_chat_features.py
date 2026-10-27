"""«Избранное», исчезающие сообщения, блокировка и жалобы, отложенные сообщения,
напоминания и галерея вложений.

Нужна PostgreSQL (TEST_DATABASE_URL); таблицы — в схеме quazar_test. Без базы тесты пропускаются.
"""

import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import attachments as attachments_api
from app.api import chats as chats_api
from app.api import later as later_api
from app.api import messages as api
from app.api import moderation as moderation_api
from app.core import push, scheduler
from app.core.config import settings
from app.core.database import Base
from app.models.chat import Chat, ChatMember
from app.models.message import Message, MessageReminder, ScheduledMessage
from app.models.moderation import UserReport
from app.models.user import User
from app.schemas.chat import SetChatTtl
from app.schemas.message import SendMessage, SetReaction
from app.ws import typing as typing_signals

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://quazar:quazar@localhost:5432/quazar"
)
SCHEMA = "quazar_test"


class FakeRequest:
    def __init__(self, body: bytes):
        self.body = body
        self.headers = {"content-length": str(len(body))}

    async def stream(self):
        yield self.body


def in_(delta: timedelta) -> datetime:
    return datetime.now(timezone.utc) + delta


class ChatFeaturesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        admin_engine = create_async_engine(DATABASE_URL)
        try:
            async with admin_engine.begin() as conn:
                await conn.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
                await conn.execute(text(f"CREATE SCHEMA {SCHEMA}"))
        except Exception as exc:  # noqa: BLE001
            await admin_engine.dispose()
            self.skipTest(f"PostgreSQL недоступна: {exc}")
        await admin_engine.dispose()

        self.engine = create_async_engine(
            DATABASE_URL, connect_args={"server_settings": {"search_path": SCHEMA}}
        )
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)

        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, True)
        for name, value in (("MEDIA_ROOT", self.media), ("MEDIA_MIN_FREE_MB", 0)):
            patcher = mock.patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.events: list[tuple[str, dict]] = []
        self.pushes: list[tuple[str, dict]] = []

        async def broadcast(user_ids, event, exclude_user=None):
            self.events.extend((uid, event) for uid in user_ids if uid != exclude_user)

        async def send(user_id, event):
            self.events.append((user_id, event))

        async def push_to_user(user_id, payload):
            self.pushes.append((user_id, payload))
            return 1

        for patcher in (
            mock.patch.multiple(api.manager, broadcast_to_users=broadcast, send_to_user=send),
            mock.patch.object(push, "send_push_to_user", push_to_user),
            mock.patch.object(typing_signals, "session_factory", self.Session),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        typing_signals.reset()
        self.addCleanup(typing_signals.reset)

        self.users: dict[str, User] = {}
        async with self.Session() as db:
            for i, name in enumerate(["alice", "bob", "eve"]):
                self.users[name] = User(username=name, phone=f"+7900000003{i}", password_hash="x")
                db.add(self.users[name])
            self.chat = Chat(type="direct")
            self.group = Chat(type="group", name="Группа")
            db.add_all([self.chat, self.group])
            await db.flush()
            for name in ("alice", "bob"):
                db.add(ChatMember(chat_id=self.chat.id, user_id=self.users[name].id))
            db.add(ChatMember(chat_id=self.group.id, user_id=self.users["alice"].id, role="owner"))
            for name in ("bob", "eve"):
                db.add(ChatMember(chat_id=self.group.id, user_id=self.users[name].id))
            await db.commit()

    async def asyncTearDown(self):
        if hasattr(self, "engine"):
            async with self.engine.begin() as conn:
                await conn.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
            await self.engine.dispose()

    # --- helpers ---

    async def call(self, fn, *args, user: str, **kwargs):
        async with self.Session() as db:
            return await fn(*args, current_user=self.users[user], db=db, **kwargs)

    async def expect_error(self, status_code: int, fn, *args, user: str, **kwargs) -> HTTPException:
        with self.assertRaises(HTTPException) as ctx:
            await self.call(fn, *args, user=user, **kwargs)
        self.assertEqual(ctx.exception.status_code, status_code, ctx.exception.detail)
        return ctx.exception

    async def send(self, payload="ENC2:x", user="alice", chat=None, **kwargs):
        chat_id = (chat or self.chat).id
        return await self.call(api.send_message, chat_id, SendMessage(payload=payload, **kwargs), user=user)

    async def history(self, user="alice", chat=None):
        chat_id = (chat or self.chat).id
        return await self.call(api.get_messages, chat_id, user=user, limit=50, before_id=None)

    async def run_job(self, job, now=None):
        async with self.Session() as db:
            return await job(db, now)

    def uid(self, name: str) -> str:
        return self.users[name].id

    def events_of(self, kind: str) -> list[tuple[str, dict]]:
        return [(uid, e) for uid, e in self.events if e["type"] == kind]

    # --- Список чатов: последнее сообщение и непрочитанные ---

    async def chat_row(self, user: str, chat):
        chats = await self.call(chats_api.list_chats, user=user)
        return next(c for c in chats if c.id == chat.id)

    async def read(self, user: str, *messages):
        from app.ws import router as ws_router

        with mock.patch.object(ws_router, "AsyncSessionLocal", self.Session):
            await ws_router._handle_status(
                {"status": "read", "message_ids": [m.id for m in messages]}, self.uid(user)
            )

    async def test_chat_list_shows_last_message_and_unread(self):
        first = await self.send("ENC2:one")
        second = await self.send("ENC2:two")
        row = await self.chat_row("bob", self.chat)
        self.assertEqual(row.last_message.id, second.id)
        self.assertEqual(row.last_message.payload, "ENC2:two")
        self.assertEqual(row.unread_count, 2)
        # Свои сообщения непрочитанными не считаются.
        self.assertEqual((await self.chat_row("alice", self.chat)).unread_count, 0)

        await self.read("bob", first, second)
        self.assertEqual((await self.chat_row("bob", self.chat)).unread_count, 0)

        # Удалённое «у меня» в превью не попадает.
        async with self.Session() as db:
            await api.hide_message(self.chat.id, second.id, current_user=self.users["bob"], db=db)
        self.assertEqual((await self.chat_row("bob", self.chat)).last_message.id, first.id)
        self.assertIsNone((await self.chat_row("eve", self.group)).last_message)

    async def test_group_unread_is_per_member(self):
        await self.send("всем привет", chat=self.group)
        later = await self.send("ещё раз", chat=self.group)
        self.assertEqual((await self.chat_row("bob", self.group)).unread_count, 2)

        await self.read("bob", later)
        self.assertEqual((await self.chat_row("bob", self.group)).unread_count, 0)
        # Боб прочитал — у Евы её сообщения всё ещё непрочитанные.
        self.assertEqual((await self.chat_row("eve", self.group)).unread_count, 2)

    # --- «Избранное» ---

    async def test_saved_chat_is_one_per_person_and_only_encrypted(self):
        first = await self.call(chats_api.open_saved_chat, user="alice")
        again = await self.call(chats_api.open_saved_chat, user="alice")
        self.assertEqual(first.id, again.id)
        self.assertEqual(first.type, "saved")
        self.assertEqual([m.user.id for m in first.members], [self.uid("alice")])
        self.assertNotEqual((await self.call(chats_api.open_saved_chat, user="bob")).id, first.id)

        saved = Chat(id=first.id, type="saved")
        await self.expect_error(422, api.send_message, saved.id, SendMessage(payload="заметка"), user="alice")
        await self.send("ENC2:заметка", chat=saved)
        self.assertEqual([m.payload for m in await self.history(chat=saved)], ["ENC2:заметка"])
        await self.expect_error(403, api.get_messages, saved.id, user="bob", limit=50, before_id=None)

        chats = await self.call(chats_api.list_chats, user="alice")
        self.assertIn(first.id, {c.id for c in chats})

    # --- Исчезающие сообщения ---

    async def test_disappearing_messages_expire_for_everyone(self):
        await self.call(chats_api.set_chat_ttl, self.chat.id, SetChatTtl(ttl_seconds=3600), user="bob")
        ttl_events = self.events_of("chat_ttl")
        self.assertEqual({uid for uid, _ in ttl_events}, {self.uid("alice"), self.uid("bob")})
        self.assertEqual(ttl_events[0][1]["ttl_seconds"], 3600)

        msg = await self.send("ENC2:секрет")
        self.assertIsNotNone(msg.expires_at)
        delta = msg.expires_at - datetime.now(timezone.utc)
        self.assertTrue(timedelta(minutes=59) < delta <= timedelta(hours=1))

        # Время вышло: в истории его уже нет, а уборка удаляет и рассылает событие.
        async with self.Session() as db:
            await db.execute(
                update(Message).where(Message.id == msg.id).values(expires_at=in_(timedelta(seconds=-1)))
            )
            await db.commit()
        self.assertEqual(await self.history(user="bob"), [])
        self.events.clear()
        self.assertEqual(await self.run_job(scheduler.expire_messages), 1)
        self.assertEqual({uid for uid, _ in self.events_of("message_deleted")}, {self.uid("alice"), self.uid("bob")})
        async with self.Session() as db:
            self.assertIsNone(await db.get(Message, msg.id))

        await self.call(chats_api.set_chat_ttl, self.chat.id, SetChatTtl(ttl_seconds=None), user="alice")
        self.assertIsNone((await self.send()).expires_at)

    async def test_disappearing_image_takes_its_file(self):
        await self.call(chats_api.set_chat_ttl, self.chat.id, SetChatTtl(ttl_seconds=3600), user="alice")
        upload = await self.call(
            attachments_api.upload_attachment, self.chat.id, request=FakeRequest(os.urandom(100)), user="alice"
        )
        msg = await self.send("ENC2:фото", attachment_id=upload.id)
        files = os.path.join(self.media, "attachments")
        self.assertEqual(os.listdir(files), [upload.id])
        await self.run_job(scheduler.expire_messages, msg.expires_at + timedelta(seconds=1))
        self.assertEqual(os.listdir(files), [])

    async def test_ttl_rules(self):
        with self.assertRaises(ValidationError):
            SetChatTtl(ttl_seconds=60)
        await self.expect_error(
            403, chats_api.set_chat_ttl, self.group.id, SetChatTtl(ttl_seconds=86400), user="bob"
        )
        await self.call(chats_api.set_chat_ttl, self.group.id, SetChatTtl(ttl_seconds=86400), user="alice")
        await self.expect_error(
            403, chats_api.set_chat_ttl, self.chat.id, SetChatTtl(ttl_seconds=86400), user="eve"
        )

    # --- Блокировка ---

    async def test_blocked_sender_keeps_writing_into_the_void(self):
        await self.call(moderation_api.block_user, self.uid("bob"), user="alice")
        self.assertEqual(self.events_of("blocks_changed")[0][0], self.uid("alice"))
        self.assertEqual(
            [u.id for u in await self.call(moderation_api.list_blocks, user="alice")], [self.uid("bob")]
        )

        self.events.clear()
        msg = await self.send("ENC2:ты тут?", user="bob")
        self.assertEqual([uid for uid, _ in self.events_of("new_message")], [self.uid("bob")])
        self.assertEqual(await self.history(user="alice"), [])
        self.assertEqual([m.id for m in await self.history(user="bob")], [msg.id])

        # Заблокировавший сам писать не может, пока не разблокирует.
        await self.expect_error(403, api.send_message, self.chat.id, SendMessage(payload="ENC2:x"), user="alice")
        await self.expect_error(
            403, api.set_reaction, self.chat.id, msg.id, SetReaction(payload="ENC2:👍"), user="bob"
        )

        self.events.clear()
        await typing_signals.handle_typing({"chat_id": self.chat.id}, self.uid("bob"))
        self.assertEqual(self.events_of("typing"), [])

        await self.call(moderation_api.unblock_user, self.uid("bob"), user="alice")
        await self.send("ENC2:снова", user="bob")
        self.assertEqual([m.payload for m in await self.history(user="alice")], ["ENC2:снова"])

    async def test_blocks_do_not_touch_groups(self):
        await self.call(moderation_api.block_user, self.uid("bob"), user="alice")
        await self.send("всем", user="bob", chat=self.group)
        self.assertEqual(len(await self.history(user="alice", chat=self.group)), 1)

    async def test_cannot_block_or_report_yourself(self):
        await self.expect_error(400, moderation_api.block_user, self.uid("alice"), user="alice")
        await self.expect_error(404, moderation_api.block_user, "нет-такого", user="alice")

    # --- Жалобы ---

    async def test_report_keeps_evidence_and_can_block(self):
        body = moderation_api.ReportBody(
            reason="spam",
            comment="рассылает рекламу",
            chat_id=self.chat.id,
            evidence=[{"sender": "them", "at": datetime.now(timezone.utc), "text": "купи"}],
            block=True,
        )
        out = await self.call(moderation_api.report_user, self.uid("bob"), body, user="alice")
        async with self.Session() as db:
            report = await db.get(UserReport, out["id"])
        self.assertEqual((report.reason, report.chat_id, report.evidence[0]["text"]), ("spam", self.chat.id, "купи"))
        self.assertEqual(
            [u.id for u in await self.call(moderation_api.list_blocks, user="alice")], [self.uid("bob")]
        )

        # Чат, где жалующегося нет, к жалобе не прикладывается.
        other = moderation_api.ReportBody(reason="abuse", chat_id=self.group.id)
        out = await self.call(moderation_api.report_user, self.uid("alice"), other, user="eve")
        async with self.Session() as db:
            self.assertEqual((await db.get(UserReport, out["id"])).chat_id, self.group.id)
        stranger = moderation_api.ReportBody(reason="abuse", chat_id=self.chat.id)
        out = await self.call(moderation_api.report_user, self.uid("bob"), stranger, user="eve")
        async with self.Session() as db:
            self.assertIsNone((await db.get(UserReport, out["id"])).chat_id)

    async def test_reports_are_rate_limited(self):
        with mock.patch.object(moderation_api, "REPORTS_PER_DAY", 2):
            for _ in range(2):
                await self.call(
                    moderation_api.report_user, self.uid("bob"), moderation_api.ReportBody(reason="spam"), user="alice"
                )
            await self.expect_error(
                429, moderation_api.report_user, self.uid("bob"), moderation_api.ReportBody(reason="spam"), user="alice"
            )

    # --- Отложенные сообщения ---

    async def test_scheduled_message_is_sent_on_time(self):
        await self.expect_error(
            422,
            later_api.schedule_message,
            self.chat.id,
            later_api.ScheduleBody(payload="ENC2:x", send_at=in_(timedelta(seconds=5))),
            user="alice",
        )
        original = await self.send("ENC2:вопрос", user="bob")
        item = await self.call(
            later_api.schedule_message,
            self.chat.id,
            later_api.ScheduleBody(payload="ENC2:с днём рождения", send_at=in_(timedelta(hours=2)), reply_to_id=original.id),
            user="alice",
        )
        self.assertEqual(
            [s.id for s in await self.call(later_api.list_scheduled, self.chat.id, user="alice")], [item.id]
        )
        self.assertEqual(await self.call(later_api.list_scheduled, self.chat.id, user="bob"), [])

        self.assertEqual(await self.run_job(scheduler.send_due_scheduled), 0)
        self.events.clear()
        self.assertEqual(await self.run_job(scheduler.send_due_scheduled, in_(timedelta(hours=3))), 1)
        delivered = [e for _, e in self.events_of("new_message")]
        self.assertEqual(delivered[0]["payload"], "ENC2:с днём рождения")
        self.assertEqual(delivered[0]["reply_to"]["id"], original.id)
        self.assertIn((self.uid("alice"), {"type": "scheduled_changed", "chat_id": self.chat.id}), self.events)
        self.assertEqual(await self.call(later_api.list_scheduled, self.chat.id, user="alice"), [])
        self.assertEqual(len(await self.history(user="bob")), 2)

    async def test_scheduled_message_can_be_cancelled_and_is_dropped_after_block(self):
        body = later_api.ScheduleBody(payload="ENC2:x", send_at=in_(timedelta(hours=1)))
        item = await self.call(later_api.schedule_message, self.chat.id, body, user="alice")
        await self.expect_error(404, later_api.cancel_scheduled, self.chat.id, item.id, user="bob")
        await self.call(later_api.cancel_scheduled, self.chat.id, item.id, user="alice")

        await self.call(later_api.schedule_message, self.chat.id, body, user="alice")
        await self.call(moderation_api.block_user, self.uid("bob"), user="alice")
        self.assertEqual(await self.run_job(scheduler.send_due_scheduled, in_(timedelta(hours=2))), 0)
        async with self.Session() as db:
            self.assertEqual((await db.execute(select(ScheduledMessage))).scalars().all(), [])
        self.assertEqual(await self.history(user="bob"), [])

    async def test_scheduled_message_takes_the_chat_ttl_at_delivery(self):
        body = later_api.ScheduleBody(payload="ENC2:x", send_at=in_(timedelta(hours=1)))
        await self.call(later_api.schedule_message, self.chat.id, body, user="alice")
        await self.call(chats_api.set_chat_ttl, self.chat.id, SetChatTtl(ttl_seconds=86400), user="bob")
        await self.run_job(scheduler.send_due_scheduled, in_(timedelta(hours=2)))
        self.assertIsNotNone((await self.history(user="bob"))[0].expires_at)

    # --- Напоминания ---

    async def test_reminder_fires_once_with_push(self):
        msg = await self.send("ENC2:купить молоко", user="bob")
        body = later_api.ReminderBody(chat_id=self.chat.id, message_id=msg.id, remind_at=in_(timedelta(hours=1)))
        first = await self.call(later_api.set_reminder, body, user="alice")
        moved = await self.call(
            later_api.set_reminder,
            later_api.ReminderBody(chat_id=self.chat.id, message_id=msg.id, remind_at=in_(timedelta(hours=5))),
            user="alice",
        )
        self.assertEqual(first.id, moved.id)
        self.assertEqual(len(await self.call(later_api.list_reminders, user="alice")), 1)
        await self.expect_error(403, later_api.set_reminder, body, user="eve")

        self.assertEqual(await self.run_job(scheduler.fire_due_reminders, in_(timedelta(hours=2))), 0)
        self.events.clear()
        self.assertEqual(await self.run_job(scheduler.fire_due_reminders, in_(timedelta(hours=6))), 1)
        self.assertEqual(
            self.events_of("reminder"),
            [(self.uid("alice"), {"type": "reminder", "reminder_id": first.id, "chat_id": self.chat.id, "message_id": msg.id})],
        )
        self.assertEqual(self.pushes[0][0], self.uid("alice"))
        self.assertNotIn("молоко", str(self.pushes[0][1]))
        async with self.Session() as db:
            self.assertEqual((await db.execute(select(MessageReminder))).scalars().all(), [])

    async def test_reminder_goes_with_its_message(self):
        msg = await self.send()
        body = later_api.ReminderBody(chat_id=self.chat.id, message_id=msg.id, remind_at=in_(timedelta(hours=1)))
        reminder = await self.call(later_api.set_reminder, body, user="bob")
        await self.call(api.delete_message, self.chat.id, msg.id, user="alice")
        await self.expect_error(404, later_api.cancel_reminder, reminder.id, user="bob")

    # --- Галерея ---

    async def test_media_lists_only_messages_with_attachments(self):
        await self.send("ENC2:текст")
        upload = await self.call(
            attachments_api.upload_attachment, self.chat.id, request=FakeRequest(os.urandom(100)), user="bob"
        )
        photo = await self.send("ENC2:фото", user="bob", attachment_id=upload.id)
        media = await self.call(api.list_media, self.chat.id, user="alice", limit=60, before_id=None)
        self.assertEqual([m.id for m in media], [photo.id])
        await self.expect_error(403, api.list_media, self.chat.id, user="eve", limit=60, before_id=None)


if __name__ == "__main__":
    unittest.main()

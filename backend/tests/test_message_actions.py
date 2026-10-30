"""Ответы, правка, удаление (у всех и у меня), реакции и «печатает…» в чатах.

Нужна PostgreSQL (TEST_DATABASE_URL); таблицы — в схеме quazar_test. Без базы тесты пропускаются.
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import attachments as attachments_api
from app.api import messages as api
from app.core import revisions
from app.core.config import settings
from app.core.database import Base
from app.models.chat import Chat, ChatMember
from app.models.message import MessageRevision
from app.models.user import User
from app.schemas.message import EditMessage, SendMessage, SetReaction
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


class MessageActionsTest(unittest.IsolatedAsyncioTestCase):
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

        async def broadcast(user_ids, event, exclude_user=None):
            self.events.extend((uid, event) for uid in user_ids if uid != exclude_user)

        async def send(user_id, event):
            self.events.append((user_id, event))

        patcher = mock.patch.multiple(api.manager, broadcast_to_users=broadcast, send_to_user=send)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(typing_signals, "session_factory", self.Session)
        patcher.start()
        self.addCleanup(patcher.stop)
        typing_signals.reset()
        self.addCleanup(typing_signals.reset)

        self.users: dict[str, User] = {}
        async with self.Session() as db:
            for i, name in enumerate(["alice", "bob", "eve"]):
                self.users[name] = User(username=name, phone=f"+7900000002{i}", password_hash="x")
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

    async def expect_error(self, status_code: int, fn, *args, user: str, **kwargs):
        with self.assertRaises(HTTPException) as ctx:
            await self.call(fn, *args, user=user, **kwargs)
        self.assertEqual(ctx.exception.status_code, status_code, ctx.exception.detail)

    async def send(self, payload: str, user="alice", chat=None, **kwargs):
        chat_id = (chat or self.chat).id
        return await self.call(api.send_message, chat_id, SendMessage(payload=payload, **kwargs), user=user)

    async def history(self, user="alice", chat=None):
        chat_id = (chat or self.chat).id
        return await self.call(api.get_messages, chat_id, user=user, limit=50, before_id=None)

    def uid(self, name: str) -> str:
        return self.users[name].id

    def events_of(self, kind: str) -> list[tuple[str, dict]]:
        return [(uid, e) for uid, e in self.events if e["type"] == kind]

    # --- ответы ---

    async def test_reply_quotes_original_in_history_and_event(self):
        original = await self.send("ENC2:вопрос")
        self.events.clear()
        answer = await self.send("ENC2:ответ", user="bob", reply_to_id=original.id)

        self.assertEqual(answer.reply_to.id, original.id)
        self.assertEqual(answer.reply_to.payload, "ENC2:вопрос")
        self.assertEqual(answer.reply_to.sender_id, self.uid("alice"))
        event = self.events_of("new_message")[0][1]
        self.assertEqual(event["reply_to"]["id"], original.id)

        history = await self.history()
        self.assertIsNone(history[0].reply_to)
        self.assertEqual(history[1].reply_to.payload, "ENC2:вопрос")

    async def test_reply_only_to_message_of_same_chat(self):
        elsewhere = await self.send("привет", chat=self.group)
        await self.expect_error(
            422, api.send_message, self.chat.id,
            SendMessage(payload="ENC2:x", reply_to_id=elsewhere.id), user="alice",
        )

    # --- правка ---

    async def test_sender_edits_and_everyone_gets_new_payload(self):
        msg = await self.send("ENC2:опечатка")
        await self.expect_error(403, api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:x"), user="bob")
        await self.expect_error(403, api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:x"), user="eve")

        self.events.clear()
        out = await self.call(api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:исправлено"), user="alice")
        self.assertEqual(out.payload, "ENC2:исправлено")
        self.assertIsNotNone(out.edited_at)
        self.assertEqual({uid for uid, _ in self.events_of("message_edited")}, {self.uid("alice"), self.uid("bob")})

        history = await self.history(user="bob")
        self.assertEqual(history[0].payload, "ENC2:исправлено")
        self.assertIsNotNone(history[0].edited_at)

    async def test_edit_history_keeps_previous_payloads(self):
        msg = await self.send("ENC2:v1")
        await self.call(api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:v2"), user="alice")
        # Тот же текст — новой версии нет.
        await self.call(api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:v2"), user="alice")
        await self.call(api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:v3"), user="alice")
        revs = await self.call(api.list_revisions, self.chat.id, msg.id, user="bob")
        self.assertEqual([r.payload for r in revs], ["ENC2:v1", "ENC2:v2"])
        self.assertLess(revs[0].written_at, revs[1].written_at)
        # Чужим и тем, кто «удалил у себя», история не отдаётся.
        await self.expect_error(403, api.list_revisions, self.chat.id, msg.id, user="eve")
        await self.call(api.hide_message, self.chat.id, msg.id, user="bob")
        await self.expect_error(404, api.list_revisions, self.chat.id, msg.id, user="bob")
        # Лимит версий.
        with mock.patch.object(revisions, "REVISIONS_KEPT", 2):
            await self.call(api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:v4"), user="alice")
        revs = await self.call(api.list_revisions, self.chat.id, msg.id, user="alice")
        self.assertEqual([r.payload for r in revs], ["ENC2:v2", "ENC2:v3"])
        # Удалили сообщение — истории нет.
        await self.call(api.delete_message, self.chat.id, msg.id, user="alice")
        async with self.Session() as db:
            left = (await db.execute(select(MessageRevision))).scalars().all()
        self.assertEqual(left, [])

    async def test_image_cannot_be_edited(self):
        upload = await self.call(
            attachments_api.upload_attachment, self.chat.id, request=FakeRequest(os.urandom(100)), user="alice"
        )
        msg = await self.send("ENC2:картинка", attachment_id=upload.id)
        await self.expect_error(422, api.edit_message, self.chat.id, msg.id, EditMessage(payload="ENC2:x"), user="alice")

    # --- удаление ---

    async def test_delete_for_everyone_only_own_in_direct_chat(self):
        msg = await self.send("ENC2:лишнее")
        reply = await self.send("ENC2:на лишнее", user="bob", reply_to_id=msg.id)
        await self.expect_error(403, api.delete_message, self.chat.id, msg.id, user="bob")

        self.events.clear()
        await self.call(api.delete_message, self.chat.id, msg.id, user="alice")
        self.assertEqual({uid for uid, _ in self.events_of("message_deleted")}, {self.uid("alice"), self.uid("bob")})

        history = await self.history(user="bob")
        self.assertEqual([m.id for m in history], [reply.id])
        self.assertIsNone(history[0].reply_to)

    async def test_group_owner_deletes_others_messages(self):
        msg = await self.send("спам", user="eve", chat=self.group)
        await self.expect_error(403, api.delete_message, self.group.id, msg.id, user="bob")
        await self.call(api.delete_message, self.group.id, msg.id, user="alice")
        self.assertEqual(await self.history(chat=self.group), [])

    async def test_deleting_image_removes_file_at_once(self):
        upload = await self.call(
            attachments_api.upload_attachment, self.chat.id, request=FakeRequest(os.urandom(100)), user="alice"
        )
        msg = await self.send("ENC2:картинка", attachment_id=upload.id)
        files = Path(self.media) / "attachments"
        self.assertEqual([p.name for p in files.iterdir()], [upload.id])
        await self.call(api.delete_message, self.chat.id, msg.id, user="alice")
        self.assertEqual(list(files.iterdir()), [])

    async def test_hide_removes_only_for_me(self):
        msg = await self.send("ENC2:секрет")
        self.events.clear()
        await self.call(api.hide_message, self.chat.id, msg.id, user="bob")
        await self.call(api.hide_message, self.chat.id, msg.id, user="bob")  # повтор — не ошибка

        self.assertEqual(await self.history(user="bob"), [])
        self.assertEqual([m.id for m in await self.history(user="alice")], [msg.id])
        self.assertEqual([uid for uid, _ in self.events_of("message_deleted")], [self.uid("bob")] * 2)
        await self.expect_error(403, api.hide_message, self.chat.id, msg.id, user="eve")

    # --- реакции ---

    async def test_reaction_one_per_person_replaced_and_removed(self):
        msg = await self.send("ENC2:фото")
        await self.call(api.set_reaction, self.chat.id, msg.id, SetReaction(payload="ENC2:👍"), user="bob")
        await self.call(api.set_reaction, self.chat.id, msg.id, SetReaction(payload="ENC2:🔥"), user="bob")
        await self.call(api.set_reaction, self.chat.id, msg.id, SetReaction(payload="ENC2:❤️"), user="alice")

        reactions = (await self.history())[0].reactions
        self.assertEqual(
            sorted((r.user_id, r.payload) for r in reactions),
            sorted([(self.uid("bob"), "ENC2:🔥"), (self.uid("alice"), "ENC2:❤️")]),
        )

        self.events.clear()
        await self.call(api.remove_reaction, self.chat.id, msg.id, user="bob")
        event = self.events_of("message_reaction")[0][1]
        self.assertEqual((event["user_id"], event["payload"]), (self.uid("bob"), None))
        self.assertEqual([r.user_id for r in (await self.history())[0].reactions], [self.uid("alice")])

        await self.expect_error(403, api.set_reaction, self.chat.id, msg.id, SetReaction(payload="ENC2:x"), user="eve")

    async def test_group_reactions_only_from_the_set(self):
        msg = await self.send("всем привет", chat=self.group)
        await self.call(api.set_reaction, self.group.id, msg.id, SetReaction(payload="🎉"), user="eve")
        await self.expect_error(
            422, api.set_reaction, self.group.id, msg.id, SetReaction(payload="лох"), user="bob"
        )

    # --- «печатает…» ---

    async def test_typing_reaches_other_members_only_and_is_throttled(self):
        await typing_signals.handle_typing({"chat_id": self.chat.id}, self.uid("alice"))
        await typing_signals.handle_typing({"chat_id": self.chat.id}, self.uid("alice"))
        self.assertEqual(
            self.events_of("typing"),
            [(self.uid("bob"), {"type": "typing", "chat_id": self.chat.id, "user_id": self.uid("alice")})],
        )

        self.events.clear()
        await typing_signals.handle_typing({"chat_id": self.chat.id}, self.uid("eve"))
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main()

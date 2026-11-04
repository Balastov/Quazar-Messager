"""Прочтение групповых сообщений: точные подтверждения и доступ только автору."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest import mock

from fastapi import Response
from sqlalchemy import delete, select, update

from app.api import messages as api
from app.models.chat import Chat, ChatMember
from app.models.message import Message, MessageReadReceipt
from app.schemas.message import SendMessage
from app.ws import router as ws
from tests.stars_base import StarsTestBase


class GroupReadersTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        patcher = mock.patch.object(ws, "AsyncSessionLocal", self.Session)
        patcher.start(); self.addCleanup(patcher.stop)
        async with self.Session() as db:
            self.group = Chat(type="group", name="Group")
            self.direct = Chat(type="direct")
            db.add_all([self.group, self.direct]); await db.flush()
            for name, role in [("owner", "owner"), ("admin", "admin"), ("alice", "member"), ("bob", "member")]:
                db.add(ChatMember(chat_id=self.group.id, user_id=self.users[name].id, role=role))
            for name in ["alice", "bob"]:
                db.add(ChatMember(chat_id=self.direct.id, user_id=self.users[name].id))
            await db.commit()

    async def message(self, user="alice", chat=None):
        return await self.call(api.send_message, (chat or self.group).id,
            SendMessage(payload="ENC2:test" if chat is self.direct else "test message"), user=user)

    async def read(self, message, user="bob", status="read", **extra):
        await ws._handle_status({"message_ids": [message.id], "status": status, **extra}, self.users[user].id)

    async def readers(self, message, user="alice", chat=None):
        response = Response()
        result = await self.call(api.message_readers, (chat or self.group).id, message.id, user=user, response=response)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        return result.readers

    async def test_each_reader_is_recorded_even_when_global_status_is_already_read(self):
        message = await self.message(); self.events.clear()
        await self.read(message)
        await self.read(message, user="admin")
        readers = await self.readers(message)
        self.assertEqual({reader.id for reader in readers}, {self.users["bob"].id, self.users["admin"].id})
        for reader in readers:
            self.assertNotIn("phone", reader.model_dump()); self.assertNotIn("email", reader.model_dump())
        events = [(uid, event) for uid, event in self.events if event["type"] == "message_read"]
        self.assertEqual(len(events), 2)
        self.assertEqual({uid for uid, _ in events}, {self.users["alice"].id})

    async def test_only_author_can_request_the_list_including_group_owner_and_admin(self):
        message = await self.message(); await self.read(message)
        for name in ["owner", "admin", "bob", "carol"]:
            await self.expect_error(403, api.message_readers, self.group.id, message.id, user=name, response=Response())
        self.assertEqual(len(await self.readers(message)), 1)

    async def test_own_history_contains_only_my_receipt_not_other_people(self):
        message = await self.message(); await self.read(message)
        for name, expected in [("bob", True), ("admin", False), ("alice", False)]:
            history = await self.call(api.get_messages, self.group.id, user=name, limit=50, before_id=None)
            self.assertEqual(history[0].read_by_me, expected)
            self.assertNotIn("readers", history[0].model_dump())

    async def test_repeated_ack_preserves_first_timestamp_and_emits_no_duplicate_author_event(self):
        message = await self.message(); await self.read(message)
        first = (await self.readers(message))[0].read_at
        self.events.clear(); await self.read(message, message_ids=[message.id, message.id])
        self.assertEqual((await self.readers(message))[0].read_at, first)
        self.assertFalse(any(event["type"] == "message_read" for _, event in self.events))
        acknowledgements = [(uid, event) for uid, event in self.events if event["type"] == "message_read_ack"]
        self.assertEqual(acknowledgements, [(self.users["bob"].id, {"type": "message_read_ack", "message_ids": [message.id]})])

    async def test_delivery_self_ack_and_outsider_do_not_create_readers(self):
        message = await self.message()
        await self.read(message, status="delivered")
        await self.read(message, user="alice")
        await self.read(message, user="carol")
        self.assertEqual(await self.readers(message), [])
        await self.read(message, user="bob", user_id=self.users["carol"].id)
        self.assertEqual([reader.id for reader in await self.readers(message)], [self.users["bob"].id])

    async def test_expired_and_hidden_messages_are_not_acknowledged(self):
        expired = await self.message(); hidden = await self.message()
        async with self.Session() as db:
            await db.execute(update(Message).where(Message.id == expired.id).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
            await db.commit()
        await self.call(api.hide_message, self.group.id, hidden.id, user="bob")
        await self.read(expired); await self.read(hidden)
        self.assertEqual(await self.readers(hidden), [])
        await self.expect_error(404, api.message_readers, self.group.id, expired.id, user="alice", response=Response())

    async def test_author_hidden_message_and_wrong_chat_are_not_exposed(self):
        message = await self.message(); await self.read(message)
        await self.expect_error(404, api.message_readers, self.direct.id, message.id, user="alice", response=Response())
        await self.call(api.hide_message, self.group.id, message.id, user="alice")
        await self.expect_error(404, api.message_readers, self.group.id, message.id, user="alice", response=Response())

    async def test_new_member_is_not_inferred_to_have_read_history_but_can_really_read_it(self):
        message = await self.message()
        async with self.Session() as db:
            db.add(ChatMember(chat_id=self.group.id, user_id=self.users["carol"].id)); await db.commit()
        self.assertEqual(await self.readers(message), [])
        await self.read(message, user="carol")
        self.assertEqual([reader.id for reader in await self.readers(message)], [self.users["carol"].id])

    async def test_receipt_survives_reader_leaving_and_is_removed_with_the_message(self):
        message = await self.message(); await self.read(message)
        async with self.Session() as db:
            await db.execute(delete(ChatMember).where(ChatMember.chat_id == self.group.id, ChatMember.user_id == self.users["bob"].id)); await db.commit()
        self.assertEqual(len(await self.readers(message)), 1)
        await self.call(api.delete_message, self.group.id, message.id, user="alice")
        async with self.Session() as db:
            self.assertEqual(list((await db.execute(select(MessageReadReceipt))).scalars()), [])

    async def test_departed_author_receives_no_new_private_read_events(self):
        message = await self.message()
        async with self.Session() as db:
            await db.execute(delete(ChatMember).where(ChatMember.chat_id == self.group.id, ChatMember.user_id == self.users["alice"].id)); await db.commit()
        self.events.clear(); await self.read(message)
        self.assertFalse(any(uid == self.users["alice"].id for uid, _ in self.events))
        await self.expect_error(403, api.message_readers, self.group.id, message.id, user="alice", response=Response())

    async def test_concurrent_readers_and_duplicate_devices_are_idempotent(self):
        message = await self.message()
        await asyncio.gather(self.read(message), self.read(message), self.read(message, user="admin"))
        self.assertEqual(len(await self.readers(message)), 2)

    async def test_direct_chat_keeps_existing_read_status_without_group_receipts(self):
        message = await self.message(chat=self.direct); await self.read(message)
        async with self.Session() as db:
            saved = await db.get(Message, message.id)
            self.assertEqual(saved.status, "read")
            self.assertEqual(list((await db.execute(select(MessageReadReceipt))).scalars()), [])
        await self.expect_error(400, api.message_readers, self.direct.id, message.id, user="alice", response=Response())

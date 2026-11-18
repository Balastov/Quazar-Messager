"""Закреплённые чаты и контакты. Нужна PostgreSQL (см. stars_base)."""

from datetime import datetime, timedelta, timezone

from app.api import pinned as api
from app.models.chat import Chat, ChatMember
from app.models.user import User
from tests.stars_base import StarsTestBase


class PinnedTest(StarsTestBase):
    async def chat(self, kind: str, *members: str) -> str:
        async with self.Session() as db:
            chat = Chat(type=kind, name="g" if kind == "group" else None)
            db.add(chat)
            await db.flush()
            for name in members:
                db.add(ChatMember(chat_id=chat.id, user_id=self.users[name].id))
            await db.commit()
            return chat.id

    async def test_pin_order_limit_and_unpin(self):
        ids = [await self.chat("direct", "alice", name) for name in ("bob", "carol", "owner", "admin", "mod")]
        ids.append(await self.chat("group", "alice", "bob"))
        for chat_id in ids[:5]:
            out = await self.call(api.pin, "chats", chat_id, user="alice")
        # Сверху — закреплённый последним.
        self.assertEqual(out.chats, list(reversed(ids[:5])))
        self.assertEqual(out.limit, 5)
        err = await self.expect_error(409, api.pin, "chats", ids[5], user="alice")
        self.assertIn("Premium", err.detail)
        # Повторное закрепление ничего не меняет и в лимит не упирается.
        out = await self.call(api.pin, "chats", ids[0], user="alice")
        self.assertEqual(len(out.chats), 5)
        out = await self.call(api.unpin, "chats", ids[0], user="alice")
        self.assertNotIn(ids[0], out.chats)
        await self.call(api.pin, "chats", ids[5], user="alice")
        # На все устройства — событием.
        self.assertTrue(any(uid == self.users["alice"].id and e["type"] == "pins_changed" for uid, e in self.events))
        # У другого — своё.
        self.assertEqual((await self.call(api.list_pins, user="bob")).chats, [])

    async def test_premium_limit_is_ten(self):
        async with self.Session() as db:
            alice = await db.get(type(self.users["alice"]), self.users["alice"].id)
            alice.premium_kind = "gift"
            alice.premium_until = datetime.now(timezone.utc) + timedelta(days=30)
            await db.commit()
            self.users["alice"] = alice
        self.assertEqual((await self.call(api.list_pins, user="alice")).limit, 10)

    async def test_only_own_chats_and_not_saved(self):
        foreign = await self.chat("direct", "bob", "carol")
        await self.expect_error(404, api.pin, "chats", foreign, user="alice")
        saved = await self.chat("saved", "alice")
        await self.expect_error(400, api.pin, "chats", saved, user="alice")

    async def test_contacts(self):
        out = await self.call(api.pin, "contacts", self.users["bob"].id, user="alice")
        self.assertEqual(out.contacts, [self.users["bob"].id])
        await self.expect_error(400, api.pin, "contacts", self.users["alice"].id, user="alice")
        await self.expect_error(404, api.pin, "contacts", "00000000-0000-0000-0000-000000000000", user="alice")

    async def test_pin_does_not_lose_a_concurrent_pin(self):
        """Пользователь уже загружен в сессию (авторизация) — под блокировкой читаем свежие закрепления."""
        async with self.Session() as db:
            me = await db.get(User, self.users["alice"].id)
            # Пока этот запрос шёл, с другого устройства закрепили Бориса.
            await self.call(api.pin, "contacts", self.users["bob"].id, user="alice")
            out = await api.pin("contacts", self.users["carol"].id, current_user=me, db=db)
        self.assertEqual(out.contacts, [self.users["carol"].id, self.users["bob"].id])
        self.assertEqual(out.rev, 2)

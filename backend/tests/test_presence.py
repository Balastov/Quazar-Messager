"""Кто в сети: кому виден статус, сводка при подключении, пауза перед «не в сети»."""

import asyncio
import unittest
from unittest import mock

from sqlalchemy import select

from app.core import presence
from app.models.chat import Chat, ChatMember
from app.models.contact import UserContact
from app.models.user import User
from app.ws.hub import manager
from tests.stars_base import StarsTestBase


class FakeSocket:
    """Достаточно, чтобы различать соединения."""


class TestPresence(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        patches = [
            mock.patch.object(presence, "session_factory", self.Session),
            mock.patch.object(presence, "OFFLINE_GRACE_SEC", 0.05),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.snapshots: list[tuple[FakeSocket, dict]] = []

        async def send(ws, event):
            self.snapshots.append((ws, event))

        p = mock.patch.object(manager, "send", send)
        p.start()
        self.addCleanup(p.stop)
        presence.reset()
        self.addCleanup(presence.reset)
        manager.user_connections.clear()
        self.addCleanup(manager.user_connections.clear)

        # alice и bob — в одной Звезде; carol — ни с кем не связана.
        self.star = await self.make_star()
        await self.join(self.star.id, "alice")
        await self.join(self.star.id, "bob")
        self.events.clear()

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def connect(self, name: str) -> FakeSocket:
        ws = FakeSocket()
        manager.user_connections[self.uid(name)].append(ws)
        await presence.on_connect(self.uid(name), ws)
        return ws

    async def disconnect(self, name: str, ws: FakeSocket):
        manager.disconnect(ws, self.uid(name))
        await presence.on_disconnect(self.uid(name))

    def presence_events(self, about: str) -> list[tuple[str, bool]]:
        return [
            (uid, e["online"])
            for uid, e in self.events
            if e["type"] == "presence" and e["user_id"] == self.uid(about)
        ]

    async def test_online_goes_to_people_who_share_a_star(self):
        await self.connect("alice")
        receivers = {uid for uid, online in self.presence_events("alice") if online}
        self.assertEqual(receivers, {self.uid("owner"), self.uid("bob")})
        self.assertTrue(presence.is_online(self.uid("alice")))

    async def test_snapshot_lists_who_i_can_see(self):
        await self.connect("bob")
        ws = await self.connect("alice")
        snapshot = next(e for sock, e in self.snapshots if sock is ws and e["type"] == "presence_snapshot")
        status = {s["user_id"]: s["online"] for s in snapshot["users"]}
        self.assertEqual(status, {self.uid("owner"): False, self.uid("bob"): True})

    async def test_offline_after_grace_with_last_seen(self):
        ws = await self.connect("alice")
        self.events.clear()
        await self.disconnect("alice", ws)
        self.assertEqual(self.presence_events("alice"), [])  # ещё ждём
        await asyncio.sleep(0.15)
        self.assertEqual({online for _, online in self.presence_events("alice")}, {False})
        async with self.Session() as db:
            last_seen = (await db.execute(select(User.last_seen_at).where(User.id == self.uid("alice")))).scalar_one()
        self.assertIsNotNone(last_seen)
        # В сводке у других — время последнего визита.
        bob_ws = await self.connect("bob")
        snapshot = next(e for sock, e in self.snapshots if sock is bob_ws)
        alice = next(s for s in snapshot["users"] if s["user_id"] == self.uid("alice"))
        self.assertEqual((alice["online"], alice["last_seen"] is not None), (False, True))

    async def test_quick_reconnect_does_not_flicker(self):
        ws = await self.connect("alice")
        self.events.clear()
        await self.disconnect("alice", ws)
        await self.connect("alice")  # перезагрузили страницу
        await asyncio.sleep(0.15)
        self.assertEqual(self.presence_events("alice"), [])
        self.assertTrue(presence.is_online(self.uid("alice")))

    async def test_second_device_keeps_me_online(self):
        phone = await self.connect("alice")
        await self.connect("alice")
        self.events.clear()
        await self.disconnect("alice", phone)
        await asyncio.sleep(0.15)
        self.assertEqual(self.presence_events("alice"), [])

    async def test_chats_and_contacts_make_status_visible(self):
        async with self.Session() as db:
            chat = Chat(type="direct")
            db.add(chat)
            await db.flush()
            db.add_all([ChatMember(chat_id=chat.id, user_id=self.uid("alice")), ChatMember(chat_id=chat.id, user_id=self.uid("carol"))])
            # mod сохранил alice в контактах телефона — видит её, но она его — нет.
            db.add(UserContact(owner_id=self.uid("mod"), contact_id=self.uid("alice"), name="Алиса"))
            await db.commit()
        self.assertIn(self.uid("carol"), await presence.audience(self.uid("alice")))
        self.assertIn(self.uid("mod"), await presence.audience(self.uid("alice")))
        seen_by_alice = {s["user_id"] for s in await presence.visible_to(self.uid("alice"))}
        self.assertIn(self.uid("carol"), seen_by_alice)
        self.assertNotIn(self.uid("mod"), seen_by_alice)
        self.assertNotIn(self.uid("admin"), await presence.audience(self.uid("carol")))


if __name__ == "__main__":
    unittest.main()

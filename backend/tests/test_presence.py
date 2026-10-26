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

    async def connect(self, name: str, active: bool = True) -> FakeSocket:
        ws = FakeSocket()
        manager.user_connections[self.uid(name)].append(ws)
        await presence.on_connect(self.uid(name), ws, active=active)
        return ws

    async def disconnect(self, name: str, ws: FakeSocket):
        manager.disconnect(ws, self.uid(name))
        await presence.on_disconnect(self.uid(name), ws)

    def statuses(self, about: str) -> list[str]:
        """Что объявляли о человеке (по одному на объявление — у bob из одной Звезды)."""
        return [
            e["status"]
            for uid, e in self.events
            if e["type"] == "presence" and e["user_id"] == self.uid(about) and uid == self.uid("bob")
        ]

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
        # И свой статус — чтобы все устройства знали ручной статус.
        self.assertEqual(status, {self.uid("owner"): False, self.uid("bob"): True, self.uid("alice"): True})

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

    # --- «Отошёл(ла)» ---------------------------------------------------------

    async def test_idle_and_back(self):
        ws = await self.connect("alice")
        self.events.clear()
        await presence.on_activity(self.uid("alice"), ws, active=False)
        await presence.on_activity(self.uid("alice"), ws, active=False)  # повтор — тишина
        self.assertEqual(self.statuses("alice"), ["away"])
        away = next(e for _, e in self.events if e["type"] == "presence")
        self.assertTrue(away["online"])  # старые клиенты видят «есть соединение»
        self.assertIsNotNone(away["away_since"])
        await presence.on_activity(self.uid("alice"), ws, active=True)
        self.assertEqual(self.statuses("alice"), ["away", "online"])

    async def test_connecting_in_background_is_away_right_away(self):
        await self.connect("alice", active=False)
        self.assertEqual(self.statuses("alice"), ["away"])
        snapshot_ws = await self.connect("bob")
        snapshot = next(e for sock, e in self.snapshots if sock is snapshot_ws)
        alice = next(s for s in snapshot["users"] if s["user_id"] == self.uid("alice"))
        self.assertEqual(alice["status"], "away")
        self.assertIsNotNone(alice["away_since"])

    async def test_closing_the_active_device_leaves_the_idle_one(self):
        pc = await self.connect("alice")
        phone = await self.connect("alice", active=False)  # свёрнутый телефон
        self.assertEqual(self.statuses("alice"), ["online"])
        await self.disconnect("alice", pc)
        self.assertEqual(self.statuses("alice"), ["online", "away"])
        await self.disconnect("alice", phone)
        await asyncio.sleep(0.15)
        self.assertEqual(self.statuses("alice"), ["online", "away", "offline"])

    # --- «На встрече» / «Не беспокоить» -------------------------------------

    async def test_manual_status_goes_to_audience_and_my_devices(self):
        from datetime import datetime, timedelta, timezone

        from app.api import users as users_api

        ws = await self.connect("alice")
        self.events.clear()
        until = datetime.now(timezone.utc) + timedelta(hours=1)
        out = await users_api.set_my_status(users_api.ManualStatusIn(kind="meeting", until=until), current_user=self.users["alice"])
        self.assertEqual(out.kind, "meeting")
        sent_to = {uid for uid, e in self.events if e["type"] == "presence"}
        self.assertEqual(sent_to, {self.uid("owner"), self.uid("bob"), self.uid("alice")})
        event = next(e for _, e in self.events if e["type"] == "presence")
        self.assertEqual((event["status"], event["manual"]["kind"]), ("online", "meeting"))

        # Отошёл — ручной статус остаётся в событии.
        self.events.clear()
        await presence.on_activity(self.uid("alice"), ws, active=False)
        away = next(e for _, e in self.events if e["type"] == "presence")
        self.assertEqual((away["status"], away["manual"]["kind"]), ("away", "meeting"))

        # В сводке у bob — тоже.
        bob_ws = await self.connect("bob")
        snapshot = next(e for sock, e in self.snapshots if sock is bob_ws)
        alice = next(s for s in snapshot["users"] if s["user_id"] == self.uid("alice"))
        self.assertEqual(alice["manual"]["kind"], "meeting")
        self.assertFalse(await presence.do_not_disturb(self.uid("alice")))

        await users_api.set_my_status(users_api.ManualStatusIn(kind="dnd"), current_user=self.users["alice"])
        self.assertTrue(await presence.do_not_disturb(self.uid("alice")))
        await users_api.set_my_status(users_api.ManualStatusIn(kind=None), current_user=self.users["alice"])
        self.assertFalse(await presence.do_not_disturb(self.uid("alice")))
        self.assertIsNone(self.events[-1][1]["manual"])

    async def test_manual_status_limits_and_expiry(self):
        from datetime import datetime, timedelta, timezone

        from app.api import users as users_api

        now = datetime.now(timezone.utc)
        from fastapi import HTTPException

        for until in (now - timedelta(minutes=1), now + timedelta(days=8)):
            with self.assertRaises(HTTPException) as ctx:
                await users_api.set_my_status(
                    users_api.ManualStatusIn(kind="dnd", until=until), current_user=self.users["alice"]
                )
            self.assertEqual(ctx.exception.status_code, 422)
        self.assertIsNone(presence._manual_out("dnd", now - timedelta(seconds=1)))
        self.assertEqual(presence._manual_out("meeting", None), {"kind": "meeting", "until": None})

    async def test_custom_status_icon_text_until(self):
        from datetime import datetime, timedelta, timezone

        from fastapi import HTTPException
        from pydantic import ValidationError

        from app.api import users as users_api

        await self.connect("alice")
        self.events.clear()
        until = datetime.now(timezone.utc) + timedelta(hours=2)
        out = await users_api.set_my_custom_status(
            users_api.CustomStatusIn(icon="plane", text="  в отпуске  до понедельника ", until=until),
            current_user=self.users["alice"],
        )
        self.assertEqual((out.icon, out.text), ("plane", "в отпуске до понедельника"))
        event = next(e for uid, e in self.events if e["type"] == "presence" and uid == self.uid("bob"))
        self.assertEqual(event["custom"]["icon"], "plane")
        self.assertIsNone(event["manual"])  # свой статус — отдельно от «на встрече» / «не беспокоить»
        self.assertFalse(await presence.do_not_disturb(self.uid("alice")))

        bob_ws = await self.connect("bob")
        snapshot = next(e for sock, e in self.snapshots if sock is bob_ws)
        alice = next(x for x in snapshot["users"] if x["user_id"] == self.uid("alice"))
        self.assertEqual(alice["custom"]["text"], "в отпуске до понедельника")

        with self.assertRaises(ValidationError):
            users_api.CustomStatusIn(icon="<svg>", text="x")
        with self.assertRaises(HTTPException):
            await users_api.set_my_custom_status(
                users_api.CustomStatusIn(text="x", until=datetime.now(timezone.utc) - timedelta(minutes=1)),
                current_user=self.users["alice"],
            )
        self.assertIsNone(presence._custom_out({"icon": "x", "text": "", "until": "2000-01-01T00:00:00+00:00"}))

        self.assertIsNone(await users_api.set_my_custom_status(users_api.CustomStatusIn(), current_user=self.users["alice"]))
        self.assertIsNone(self.events[-1][1]["custom"])

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
        seen_by_alice = {s["user_id"] for s in await presence.visible_to(self.uid("alice"))} - {self.uid("alice")}
        self.assertIn(self.uid("carol"), seen_by_alice)
        self.assertNotIn(self.uid("mod"), seen_by_alice)
        self.assertNotIn(self.uid("admin"), await presence.audience(self.uid("carol")))


if __name__ == "__main__":
    unittest.main()

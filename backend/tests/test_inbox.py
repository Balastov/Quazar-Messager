"""Зелёный колокольчик: уведомления о бронях и отметка «прочитано»."""

from datetime import datetime, timedelta, timezone
from unittest import mock

from app.api import inbox as inbox_api
from app.api import star_work as work
from tests.stars_base import StarsTestBase


def soon(minutes: int) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


class InboxTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pushes: list[tuple[str, dict]] = []

        async def push(user_id, payload):
            self.pushes.append((user_id, payload))
            return 1

        async def set_manual(user_id, kind, until):
            return None

        for patcher in (
            mock.patch.object(work, "send_push_to_user", push),
            mock.patch.object(work.presence, "set_manual", set_manual),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles(kind="work")
        self.room = next(c for c in self.star.channels if c.kind == "planet" and c.room_kind != "lobby")

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def inbox(self, user: str):
        return await self.call(inbox_api.list_inbox, user=user, before=None, limit=30)

    async def book(self, attendees=("bob", "mod"), user="alice", title="Планёрка", start=60, end=90):
        return await self.call(
            work.create_booking, self.star.id, self.room.id,
            work.BookingBody(title=title, starts_at=soon(start), ends_at=soon(end),
                             attendees=[self.uid(n) for n in attendees]),
            user=user,
        )

    async def test_marked_people_get_an_invite_in_the_bell(self):
        booking = await self.book()
        for name in ("bob", "mod"):
            box = await self.inbox(name)
            self.assertEqual(box.unread, 1)
            item = box.items[0]
            self.assertEqual(item.kind, "booking_invite")
            self.assertIn("Планёрка", item.title)
            self.assertIn(self.room.name, item.body)
            self.assertEqual(item.data["channel_id"], self.room.id)
            self.assertEqual(item.data["booking_id"], booking.id)
        # Автор и неотмеченные ничего не получают.
        self.assertEqual((await self.inbox("alice")).unread, 0)
        self.assertEqual((await self.inbox("owner")).unread, 0)
        # Сразу видно на открытых устройствах; push — отмеченным.
        live = [uid for uid, e in self.events if e["type"] == "inbox_new"]
        self.assertEqual(sorted(live), sorted([self.uid("bob"), self.uid("mod")]))
        self.assertEqual({uid for uid, p in self.pushes if p.get("type") == "inbox"}, {self.uid("bob"), self.uid("mod")})

    async def test_reading_lowers_the_counter_on_every_device(self):
        await self.book(title="Раз")
        await self.book(title="Два", start=100, end=120)
        box = await self.inbox("bob")
        self.assertEqual(box.unread, 2)
        self.events.clear()
        left = await self.call(inbox_api.read_one, box.items[0].id, user="bob")
        self.assertEqual(left.unread, 1)
        self.assertIn((self.uid("bob"), {"type": "inbox_read", "ids": [box.items[0].id], "unread": 1}), self.events)
        # Чужое уведомление не прочитать.
        await self.expect_error(404, inbox_api.read_one, box.items[1].id, user="mod")
        self.assertEqual((await self.call(inbox_api.read_all, user="bob")).unread, 0)
        box = await self.inbox("bob")
        self.assertTrue(all(i.read_at for i in box.items))

    async def test_cancellation_reminder_and_start_reach_the_bell(self):
        booking = await self.book(start=30, end=60)
        await self.call(inbox_api.read_all, user="bob")
        async with self.Session() as db:
            await work.booking_tick(db, booking.starts_at - timedelta(minutes=5))
            await work.booking_tick(db, booking.starts_at + timedelta(minutes=1))
        bob = [i.kind for i in (await self.inbox("bob")).items]
        alice = [i.kind for i in (await self.inbox("alice")).items]
        self.assertEqual(bob[:2], ["booking_started", "booking_soon"])
        self.assertEqual(alice, ["booking_started", "booking_soon"])

        # Отменил админ — узнают и автор, и отмеченные, но не сам отменивший.
        await self.call(work.cancel_booking, self.star.id, booking.id, user="admin")
        for name in ("alice", "bob", "mod"):
            first = (await self.inbox(name)).items[0]
            self.assertEqual(first.kind, "booking_cancelled")
            self.assertIn("отменена", first.title)
        self.assertEqual((await self.inbox("admin")).unread, 0)

    async def test_author_cancelling_tells_only_the_marked(self):
        booking = await self.book(attendees=("bob",))
        await self.call(work.cancel_booking, self.star.id, booking.id, user="alice")
        self.assertEqual([i.kind for i in (await self.inbox("bob")).items], ["booking_cancelled", "booking_invite"])
        self.assertEqual((await self.inbox("alice")).items, [])

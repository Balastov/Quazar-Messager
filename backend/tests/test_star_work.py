"""Рабочие Звёзды: ветки, объявления с «Ознакомлен(а)», рабочее время, брони комнат, табличка на двери.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from sqlalchemy import update

from app.api import star_work as work
from app.api import stars as api
from app.core import work_hours
from app.models.star import Star
from app.models.star import StarChannel
from app.models.user import User
from app.schemas.star import CreateChannel, SendStarMessage, UpdateChannel
from tests.stars_base import StarsTestBase

WEEKDAYS = {"days": [1, 2, 3, 4, 5], "start": "10:00", "end": "19:00", "tz": "Asia/Yekaterinburg"}


class IsWorkingTest(unittest.TestCase):
    def test_day_shift_in_own_time_zone(self):
        # Пн 27.10.2026 05:30 UTC = 10:30 в Екатеринбурге (UTC+5).
        self.assertTrue(work_hours.is_working(WEEKDAYS, datetime(2026, 10, 26, 5, 30, tzinfo=timezone.utc)))
        self.assertFalse(work_hours.is_working(WEEKDAYS, datetime(2026, 10, 26, 4, 30, tzinfo=timezone.utc)))
        # Сб.
        self.assertFalse(work_hours.is_working(WEEKDAYS, datetime(2026, 10, 31, 6, 0, tzinfo=timezone.utc)))

    def test_night_shift_continues_after_midnight(self):
        night = {"days": [5], "start": "22:00", "end": "06:00", "tz": "UTC"}
        self.assertTrue(work_hours.is_working(night, datetime(2026, 10, 30, 23, 0, tzinfo=timezone.utc)))  # пт
        self.assertTrue(work_hours.is_working(night, datetime(2026, 10, 31, 5, 0, tzinfo=timezone.utc)))  # утро сб
        self.assertFalse(work_hours.is_working(night, datetime(2026, 10, 30, 5, 0, tzinfo=timezone.utc)))  # утро пт

    def test_normalize_rejects_garbage(self):
        for bad in ({"days": [], "start": "09:00", "end": "18:00", "tz": "UTC"},
                    {"days": [8], "start": "09:00", "end": "18:00", "tz": "UTC"},
                    {"days": [1], "start": "9:00", "end": "18:00", "tz": "UTC"},
                    {"days": [1], "start": "09:00", "end": "09:00", "tz": "UTC"},
                    {"days": [1], "start": "09:00", "end": "18:00", "tz": "Mars/Base"}):
            with self.assertRaises(ValueError):
                work_hours.normalize(bad)
        self.assertEqual(work_hours.normalize({**WEEKDAYS, "days": [3, 1, 1]})["days"], [1, 3])


def soon(minutes: int) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


class StarWorkTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pushes: list[tuple[str, dict]] = []
        self.statuses: list[tuple[str, str, datetime]] = []

        async def push(user_id, payload):
            self.pushes.append((user_id, payload))
            return 1

        async def set_manual(user_id, kind, until):
            self.statuses.append((user_id, kind, until))

        for patcher in (
            mock.patch.object(work, "send_push_to_user", push),
            mock.patch.object(work.presence, "set_manual", set_manual),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")
        self.room = next(c for c in self.star.channels if c.kind == "planet" and c.room_kind != "lobby")

    def uid(self, name: str) -> str:
        return self.users[name].id

    def events_of(self, kind: str) -> list[dict]:
        return [e for _, e in self.events if e["type"] == kind]

    async def say(self, text: str, user: str = "alice", channel=None, **kwargs):
        channel_id = (channel or self.sat).id
        return await self.call(api.send_message, self.star.id, channel_id, SendStarMessage(text=text, **kwargs), user=user)

    async def feed(self, user: str = "bob", channel=None):
        return await self.call(api.list_messages, self.star.id, (channel or self.sat).id, user=user, limit=50, before_id=None)

    # --- Ветки ---

    async def test_thread_replies_stay_out_of_the_channel_feed(self):
        root = await self.say("Обсудим релиз?")
        self.events.clear()
        await self.say("Да, в 15:00", user="bob", thread_id=root.id)
        await self.say("Я за", user="mod", thread_id=root.id)
        summary = self.events_of("star_thread")[-1]
        self.assertEqual((summary["root_id"], summary["count"]), (root.id, 2))

        feed = await self.feed()
        self.assertEqual([m.text for m in feed], ["Обсудим релиз?"])
        self.assertEqual(feed[0].thread_count, 2)
        self.assertEqual(feed[0].thread_participants, [self.uid("mod"), self.uid("bob")])

        thread = await self.call(work.thread_messages, self.star.id, self.sat.id, root.id, user="owner", limit=100)
        self.assertEqual([m.text for m in thread], ["Обсудим релиз?", "Да, в 15:00", "Я за"])
        reply = thread[1]
        await self.expect_error(
            422, api.send_message, self.star.id, self.sat.id, SendStarMessage(text="x", thread_id=reply.id), user="bob"
        )

        await self.call(api.delete_message, self.star.id, self.sat.id, reply.id, user="bob")
        self.assertEqual(self.events_of("star_thread")[-1]["count"], 1)
        await self.call(api.delete_message, self.star.id, self.sat.id, root.id, user="alice")
        thread = await self.call(api.list_messages, self.star.id, self.sat.id, user="owner", limit=50, before_id=None)
        self.assertEqual(thread, [])

    # --- Объявления ---

    async def test_announcements_and_acknowledgements(self):
        news = await self.call(
            api.create_channel, self.star.id, CreateChannel(kind="satellite", name="объявления", announcement=True), user="owner"
        )
        await self.expect_error(
            403, api.send_message, self.star.id, news.id, SendStarMessage(text="можно?"), user="alice"
        )
        await self.expect_error(
            422, api.send_message, self.star.id, self.sat.id, SendStarMessage(text="x", ack_required=True), user="admin"
        )
        post = await self.say("С понедельника — новый пропуск", user="admin", channel=news, ack_required=True)
        self.assertTrue(post.ack_required)
        await self.say("А старый действует?", user="alice", channel=news, thread_id=post.id)  # обсуждать — можно

        await self.call(work.ack, self.star.id, post.id, user="alice")
        again = await self.call(work.ack, self.star.id, post.id, user="alice")
        self.assertEqual(again.ack_count, 1)  # повторное нажатие не считается дважды
        self.assertEqual(self.events_of("star_ack")[-1]["ack_count"], 1)
        feed = await self.feed(user="alice", channel=news)
        self.assertEqual((feed[0].ack_count, feed[0].acked), (1, True))
        self.assertFalse((await self.feed(user="bob", channel=news))[0].acked)

        out = await self.call(work.acks, self.star.id, post.id, user="admin")
        self.assertEqual([u.username for u in out.acked], ["alice"])
        self.assertEqual(sorted(u.username for u in out.pending), ["bob", "mod", "owner"])
        await self.expect_error(403, work.acks, self.star.id, post.id, user="bob")

        await self.call(api.update_channel, self.star.id, news.id, UpdateChannel(announcement=False), user="owner")
        await self.say("теперь можно", user="alice", channel=news)

    # --- Рабочее время ---

    async def test_work_hours_are_set_only_by_owner_and_admins(self):
        body = work.StarWorkHoursBody(enabled=True, schedule=work.Schedule(**WEEKDAYS))
        await self.expect_error(403, work.set_star_work_hours, self.star.id, body, user="mod")
        await self.expect_error(403, work.set_star_work_hours, self.star.id, body, user="alice")
        await self.call(work.set_star_work_hours, self.star.id, body, user="admin")
        detail = await self.call(api.get_star, self.star.id, user="bob")
        self.assertEqual((detail.work_hours_enabled, detail.work_hours["tz"]), (True, "Asia/Yekaterinburg"))

        bad = work.StarWorkHoursBody(enabled=True, schedule=work.Schedule(days=[1], start="9", end="18:00", tz="UTC"))
        await self.expect_error(422, work.set_star_work_hours, self.star.id, bad, user="owner")

        # Выключили — общий график остаётся на будущее.
        await self.call(work.set_star_work_hours, self.star.id, work.StarWorkHoursBody(enabled=False), user="owner")
        detail = await self.call(api.get_star, self.star.id, user="bob")
        self.assertEqual((detail.work_hours_enabled, detail.work_hours["start"]), (False, "10:00"))

    async def test_personal_schedule_shown_only_where_work_hours_are_on(self):
        mine = work.MyScheduleBody(schedule=work.Schedule(days=[2, 3, 4], start="12:00", end="20:00", tz="Europe/Berlin"))
        await self.call(work.set_my_schedule, mine, user="alice")
        alice = next(m for m in (await self.call(api.get_star, self.star.id, user="bob")).members if m.user.id == self.uid("alice"))
        self.assertIsNone(alice.work_schedule)

        await self.call(work.set_star_work_hours, self.star.id, work.StarWorkHoursBody(enabled=True), user="owner")
        alice = next(m for m in (await self.call(api.get_star, self.star.id, user="bob")).members if m.user.id == self.uid("alice"))
        self.assertEqual(alice.work_schedule["tz"], "Europe/Berlin")

        self.events.clear()
        await self.call(work.set_my_schedule, work.MyScheduleBody(schedule=None), user="alice")
        upserts = [e for e in self.events_of("star_member_upsert") if e["member"]["user"]["id"] == self.uid("alice")]
        self.assertIsNone(upserts[-1]["member"]["work_schedule"])

    async def test_resting_follows_personal_schedule(self):
        always = {"days": [1, 2, 3, 4, 5, 6, 7], "start": "00:00", "end": "23:59", "tz": "UTC"}
        never = {"days": [1], "start": "00:00", "end": "00:01", "tz": "Pacific/Kiritimati"}
        await self.call(work.set_my_schedule, work.MyScheduleBody(schedule=work.Schedule(**never)), user="alice")
        await self.call(work.set_star_work_hours, self.star.id,
                        work.StarWorkHoursBody(enabled=True, schedule=work.Schedule(**always)), user="owner")
        ids = [self.uid("alice"), self.uid("bob")]
        at = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)
        async with self.Session() as db:
            star = await db.get(Star, self.star.id)
            self.assertEqual(await work_hours.resting(db, star, ids, at), {self.uid("alice")})
            star.work_hours_enabled = False
            self.assertEqual(await work_hours.resting(db, star, ids, at), set())

    # --- Брони ---

    async def test_booking_rules(self):
        meeting = work.BookingBody(title="Планёрка", starts_at=soon(60), ends_at=soon(90), attendees=[self.uid("bob"), "чужой"])
        booking = await self.call(work.create_booking, self.star.id, self.room.id, meeting, user="alice")
        self.assertEqual(booking.attendees, [self.uid("bob")])
        clash = await self.expect_error(
            409, work.create_booking, self.star.id, self.room.id,
            work.BookingBody(title="Ретро", starts_at=soon(80), ends_at=soon(120)), user="bob",
        )
        self.assertIn("Планёрка", clash.detail)
        await self.call(
            work.create_booking, self.star.id, self.room.id,
            work.BookingBody(title="Ретро", starts_at=soon(90), ends_at=soon(120)), user="bob",
        )
        for start, end in ((90, 60), (60, 60 + 9 * 60), (-90, -30)):
            await self.expect_error(
                422, work.create_booking, self.star.id, self.room.id,
                work.BookingBody(title="x", starts_at=soon(start), ends_at=soon(end)), user="bob",
            )
        listed = await self.call(work.list_bookings, self.star.id, user="mod", start=None, end=None)
        self.assertEqual([b.title for b in listed], ["Планёрка", "Ретро"])

        await self.expect_error(403, work.cancel_booking, self.star.id, booking.id, user="bob")
        await self.call(work.cancel_booking, self.star.id, booking.id, user="admin")

        gaming = await self.make_star(kind="gaming", name="Игры")
        planet = next(c for c in gaming.channels if c.kind == "planet")
        await self.expect_error(
            400, work.create_booking, gaming.id, planet.id,
            work.BookingBody(title="x", starts_at=soon(60), ends_at=soon(90)), user="owner",
        )

    async def test_booking_reminds_and_sets_meeting_status(self):
        b = await self.call(
            work.create_booking, self.star.id, self.room.id,
            work.BookingBody(title="Демо", starts_at=soon(30), ends_at=soon(60), attendees=[self.uid("bob"), self.uid("mod")]),
            user="alice",
        )
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.uid("mod")).values(manual_status="dnd"))
            await db.commit()
            self.assertEqual(await work.booking_tick(db), 0)
            self.assertEqual(await work.booking_tick(db, b.starts_at - timedelta(minutes=5)), 1)
            self.assertEqual(await work.booking_tick(db, b.starts_at - timedelta(minutes=4)), 0)  # уже напомнили
        reminded = {uid for uid, e in self.events if e["type"] == "star_booking_soon"}
        self.assertEqual(reminded, {self.uid("alice"), self.uid("bob"), self.uid("mod")})
        self.assertEqual(len(self.pushes), 3)

        async with self.Session() as db:
            self.assertEqual(await work.booking_tick(db, b.starts_at + timedelta(minutes=1)), 1)
        # «Не беспокоить» у модератора не перебиваем.
        self.assertEqual({(uid, kind) for uid, kind, _ in self.statuses}, {(self.uid("alice"), "meeting"), (self.uid("bob"), "meeting")})
        self.assertEqual(self.statuses[0][2], b.ends_at)

    # --- Табличка на двери ---

    async def test_door_sign_on_personal_cabinet(self):
        cabinet = await self.call(
            api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Кабинет Боба", access="personal", cabinet_owner_id=self.uid("bob")),
            user="owner",
        )
        sign = work.DoorSignBody(kind="dnd", until=soon(60))
        await self.expect_error(403, work.set_door_sign, self.star.id, cabinet.id, sign, user="alice")
        await self.expect_error(400, work.set_door_sign, self.star.id, self.room.id, sign, user="owner")
        slot = work.BookingBody(title="Встреча", starts_at=soon(30), ends_at=soon(60))
        await self.expect_error(400, work.create_booking, self.star.id, cabinet.id, slot, user="bob")
        await self.expect_error(
            422, work.set_door_sign, self.star.id, cabinet.id, work.DoorSignBody(kind="custom", text=" "), user="bob"
        )
        await self.call(work.set_door_sign, self.star.id, cabinet.id, sign, user="bob")
        channel = next(c for c in (await self.call(api.get_star, self.star.id, user="alice")).channels if c.id == cabinet.id)
        self.assertEqual(channel.door_sign_kind, "dnd")

        # Срок прошёл — табличка пропадает сама.
        async with self.Session() as db:
            await db.execute(
                update(StarChannel).where(StarChannel.id == cabinet.id).values(door_sign_until=soon(-1))
            )
            await db.commit()
        channel = next(c for c in (await self.call(api.get_star, self.star.id, user="alice")).channels if c.id == cabinet.id)
        self.assertIsNone(channel.door_sign_kind)
        await self.call(work.set_door_sign, self.star.id, cabinet.id, work.DoorSignBody(kind="welcome"), user="admin")


if __name__ == "__main__":
    unittest.main()

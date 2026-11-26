"""Повторяющиеся брони комнат: правило повтора, серия встреч, занятые дни, отмена, дописывание окна.

Тестам серии нужна PostgreSQL (TEST_DATABASE_URL); без базы они пропускаются. Правила — без базы.
"""

import unittest
from datetime import date, datetime, timedelta, timezone
from itertools import islice
from unittest import mock
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.api import star_work as work
from app.core import recurrence
from app.models.inbox import InboxNotification
from app.models.star import StarBooking, StarBookingSeries
from tests.stars_base import StarsTestBase

MSK = ZoneInfo("Europe/Moscow")


def at(y, m, d, h=10, minute=0, tz=MSK) -> datetime:
    return datetime(y, m, d, h, minute, tzinfo=tz)


def days(rule: dict, first: datetime, n: int = 6, tz: str = "Europe/Moscow") -> list[date]:
    rule = recurrence.normalize(rule, first.astimezone(ZoneInfo(tz)).date())
    return [s.date() for s in islice(recurrence.occurrences(rule, first, tz), n)]


class RecurrenceTest(unittest.TestCase):
    def test_weekly_on_chosen_days(self):
        # Вт 01.12.2026, по вторникам и четвергам.
        self.assertEqual(
            days({"freq": "weekly", "weekdays": [1, 3]}, at(2026, 12, 1), 4),
            [date(2026, 12, 1), date(2026, 12, 3), date(2026, 12, 8), date(2026, 12, 10)],
        )
        # Раз в две недели по понедельникам.
        self.assertEqual(
            days({"freq": "weekly", "interval": 2, "weekdays": [0]}, at(2026, 11, 30), 3),
            [date(2026, 11, 30), date(2026, 12, 14), date(2026, 12, 28)],
        )

    def test_weekdays_skip_the_weekend(self):
        # Пт 04.12.2026 → пн, вт.
        self.assertEqual(
            days({"freq": "weekly", "weekdays": [0, 1, 2, 3, 4]}, at(2026, 12, 4), 3),
            [date(2026, 12, 4), date(2026, 12, 7), date(2026, 12, 8)],
        )

    def test_monthly_by_day_skips_short_months(self):
        self.assertEqual(
            days({"freq": "monthly"}, at(2027, 1, 31), 3),
            [date(2027, 1, 31), date(2027, 3, 31), date(2027, 5, 31)],
        )

    def test_monthly_by_weekday_and_last_weekday(self):
        # Вт 08.12.2026 — второй вторник.
        self.assertEqual(
            days({"freq": "monthly", "monthly": "weekday"}, at(2026, 12, 8), 3),
            [date(2026, 12, 8), date(2027, 1, 12), date(2027, 2, 9)],
        )
        # Пт 25.12.2026 — последняя пятница.
        self.assertEqual(
            days({"freq": "monthly", "monthly": "last_weekday"}, at(2026, 12, 25), 3),
            [date(2026, 12, 25), date(2027, 1, 29), date(2027, 2, 26)],
        )
        with self.assertRaises(ValueError):
            recurrence.normalize({"freq": "monthly", "monthly": "last_weekday"}, date(2026, 12, 8))

    def test_count_and_until_end_the_series(self):
        self.assertEqual(len(days({"freq": "daily", "count": 3}, at(2026, 12, 1), 10)), 3)
        self.assertEqual(days({"freq": "daily", "until": "2026-12-03"}, at(2026, 12, 1), 10)[-1], date(2026, 12, 3))
        for bad in ({"freq": "daily", "until": "2026-11-30"}, {"freq": "daily", "count": 3, "until": "2026-12-09"},
                    {"freq": "yearly"}, {"freq": "weekly", "weekdays": [7]}, {"freq": "daily", "interval": 99}):
            with self.assertRaises(ValueError, msg=bad):
                recurrence.normalize(bad, date(2026, 12, 1))

    def test_wall_clock_time_survives_daylight_saving(self):
        berlin = ZoneInfo("Europe/Berlin")
        starts = list(islice(recurrence.occurrences(
            recurrence.normalize({"freq": "weekly"}, date(2027, 3, 22)), at(2027, 3, 22, tz=berlin), "Europe/Berlin"), 2))
        self.assertEqual([s.astimezone(berlin).hour for s in starts], [10, 10])
        self.assertEqual([s.astimezone(timezone.utc).hour for s in starts], [9, 8])

    def test_describe_in_russian(self):
        cases = [
            ({"freq": "daily", "interval": 1}, date(2026, 12, 1), "каждый день"),
            ({"freq": "daily", "interval": 3}, date(2026, 12, 1), "раз в 3 дня"),
            ({"freq": "weekly", "interval": 1, "weekdays": [0, 1, 2, 3, 4]}, date(2026, 12, 1), "по будням"),
            ({"freq": "weekly", "interval": 1, "weekdays": [1, 3]}, date(2026, 12, 1), "по вторникам и четвергам"),
            ({"freq": "weekly", "interval": 2, "weekdays": [2]}, date(2026, 12, 2), "раз в 2 недели, по средам"),
            ({"freq": "monthly", "interval": 1, "monthly": "day"}, date(2026, 12, 15), "каждый месяц, 15-го числа"),
            ({"freq": "monthly", "interval": 1, "monthly": "weekday"}, date(2026, 12, 8), "каждый месяц, во второй вторник"),
            ({"freq": "monthly", "interval": 1, "monthly": "weekday"}, date(2026, 12, 16), "каждый месяц, в третью среду"),
            ({"freq": "monthly", "interval": 1, "monthly": "last_weekday"}, date(2026, 12, 25), "каждый месяц, в последнюю пятницу"),
            ({"freq": "daily", "interval": 1, "count": 5}, date(2026, 12, 1), "каждый день, 5 раз"),
            ({"freq": "daily", "interval": 1, "until": "2026-12-31"}, date(2026, 12, 1), "каждый день, до 31.12.2026"),
        ]
        for rule, first, text in cases:
            self.assertEqual(recurrence.describe(rule, first), text)


def next_weekday(weekday: int, hour: int = 10) -> datetime:
    """Ближайший такой день недели (не раньше завтра) в hour:00 по Москве."""
    day = datetime.now(MSK).date() + timedelta(days=1)
    while day.weekday() != weekday:
        day += timedelta(days=1)
    return datetime(day.year, day.month, day.day, hour, tzinfo=MSK)


class BookingSeriesTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pushes = []

        async def push(user_id, payload):
            self.pushes.append((user_id, payload))
            return 1

        patcher = mock.patch.object(work, "send_push_to_user", push)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles(kind="work")
        self.room = next(c for c in self.star.channels if c.kind == "planet" and c.room_kind != "lobby")
        self.first = next_weekday(1)

    def uid(self, name: str) -> str:
        return self.users[name].id

    def weekly(self, title="Планёрка", start=None, **kwargs) -> work.BookingBody:
        start = start or self.first
        return work.BookingBody(
            title=title, starts_at=start, ends_at=start + timedelta(hours=1), tz="Europe/Moscow",
            repeat=work.RepeatBody(freq="weekly", weekdays=[start.weekday()]), **kwargs,
        )

    async def series_rows(self) -> list[StarBooking]:
        async with self.Session() as db:
            return list((await db.execute(
                select(StarBooking).where(StarBooking.series_id.is_not(None)).order_by(StarBooking.starts_at)
            )).scalars())

    async def inbox(self, name: str, kind: str) -> list[InboxNotification]:
        async with self.Session() as db:
            return list((await db.execute(select(InboxNotification).where(
                InboxNotification.user_id == self.uid(name), InboxNotification.kind == kind))).scalars())

    async def test_weekly_series_books_sixty_days_ahead_and_invites_once(self):
        first = await self.call(work.create_booking, self.star.id, self.room.id,
                                self.weekly(attendees=[self.uid("bob")]), user="alice")
        self.assertEqual(first.starts_at, self.first)
        self.assertEqual(first.repeat["weekdays"], [1])
        rows = await self.series_rows()
        self.assertGreaterEqual(len(rows), 8)
        self.assertTrue(all(r.starts_at - rows[0].starts_at == timedelta(weeks=i) for i, r in enumerate(rows)))
        self.assertTrue(all(r.starts_at <= work._now() + work.BOOK_AHEAD for r in rows))
        [invite] = await self.inbox("bob", "booking_invite")
        self.assertIn("регулярную", invite.title)
        self.assertIn("по вторникам, 10:00–11:00", invite.body)
        listed = await self.call(work.list_bookings, self.star.id, user="bob", start=None, end=self.first + timedelta(days=8))
        self.assertEqual({b.series_id for b in listed}, {first.series_id})

    async def test_busy_days_are_listed_and_can_be_skipped(self):
        second = self.first + timedelta(weeks=1)
        await self.call(work.create_booking, self.star.id, self.room.id, work.BookingBody(
            title="Ретро", starts_at=second + timedelta(minutes=30), ends_at=second + timedelta(hours=2)), user="bob")
        clash = await self.expect_error(409, work.create_booking, self.star.id, self.room.id, self.weekly(), user="alice")
        self.assertEqual([(b["title"], b["starts_at"]) for b in clash.detail["busy"]], [("Ретро", second.isoformat())])
        self.assertIn("занята в 1 день", clash.detail["message"])
        self.assertEqual(await self.series_rows(), [])

        await self.call(work.create_booking, self.star.id, self.room.id, self.weekly(skip_busy=True), user="alice")
        starts = [r.starts_at for r in await self.series_rows()]
        self.assertIn(self.first, starts)
        self.assertNotIn(second, starts)

    async def test_all_days_busy_is_refused_even_when_skipping(self):
        await self.call(work.create_booking, self.star.id, self.room.id, work.BookingBody(
            title="Своё", starts_at=self.first, ends_at=self.first + timedelta(hours=1)), user="bob")
        body = work.BookingBody(
            title="x", starts_at=self.first, ends_at=self.first + timedelta(hours=1), skip_busy=True,
            repeat=work.RepeatBody(freq="daily", count=2), tz="Europe/Moscow")
        await self.call(work.create_booking, self.star.id, self.room.id, work.BookingBody(
            title="Своё 2", starts_at=self.first + timedelta(days=1), ends_at=self.first + timedelta(days=1, hours=1)), user="bob")
        clash = await self.expect_error(409, work.create_booking, self.star.id, self.room.id, body, user="alice")
        self.assertEqual(clash.detail["free"], 0)

    async def test_count_limits_the_series(self):
        body = self.weekly()
        body.repeat.count = 3
        await self.call(work.create_booking, self.star.id, self.room.id, body, user="alice")
        self.assertEqual(len(await self.series_rows()), 3)
        async with self.Session() as db:
            [series] = (await db.execute(select(StarBookingSeries))).scalars().all()
            self.assertTrue(series.finished)

    async def test_cancel_one_following_or_all(self):
        await self.call(work.create_booking, self.star.id, self.room.id,
                        self.weekly(attendees=[self.uid("bob")]), user="alice")
        rows = await self.series_rows()
        total = len(rows)
        await self.call(work.cancel_booking, self.star.id, rows[1].id, user="alice", scope="one")
        self.assertEqual(len(await self.series_rows()), total - 1)

        await self.expect_error(403, work.cancel_booking, self.star.id, rows[3].id, user="bob", scope="all")
        await self.call(work.cancel_booking, self.star.id, rows[3].id, user="alice", scope="following")
        self.assertEqual([r.id for r in await self.series_rows()], [rows[0].id, rows[2].id])
        cancelled = await self.inbox("bob", "booking_cancelled")
        self.assertIn("отменены с", cancelled[-1].title)
        async with self.Session() as db:
            self.assertTrue((await db.get(StarBookingSeries, rows[0].series_id)).finished)
            # Окно сдвинулось — отменённые «дальше» встречи не возвращаются.
            self.assertEqual(await work.extend_series(db, work._now() + timedelta(days=30)), 0)

        await self.call(work.cancel_booking, self.star.id, rows[0].id, user="admin", scope="all")
        self.assertEqual(await self.series_rows(), [])
        async with self.Session() as db:
            self.assertEqual((await db.execute(select(StarBookingSeries))).scalars().all(), [])

    async def test_scheduler_extends_the_window_and_reports_busy_days(self):
        await self.call(work.create_booking, self.star.id, self.room.id, self.weekly(), user="alice")
        before = await self.series_rows()
        later = work._now() + timedelta(days=21)
        # Через три недели в окно войдут ещё три вторника; один из них заранее занят разовой бронью.
        busy_day = before[-1].starts_at + timedelta(weeks=2)
        async with self.Session() as db:
            db.add(StarBooking(star_id=self.star.id, channel_id=self.room.id, title="Чужая", starts_at=busy_day,
                               ends_at=busy_day + timedelta(hours=1), created_by=self.uid("bob"), attendees=[]))
            await db.commit()
            self.assertEqual(await work.extend_series(db, work._now()), 0)  # окно ещё не сдвинулось
            made = await work.extend_series(db, later)
        after = await self.series_rows()
        self.assertEqual(len(after), len(before) + made)
        self.assertGreaterEqual(made, 1)
        self.assertNotIn(busy_day, [r.starts_at for r in after])
        [skipped] = await self.inbox("alice", "booking_busy")
        self.assertIn("не забронирована", skipped.title)
        self.assertIn("Чужая", skipped.body)

    async def test_series_stops_when_its_author_leaves(self):
        await self.call(work.create_booking, self.star.id, self.room.id, self.weekly(), user="alice")
        async with self.Session() as db:
            from app.models.star import StarMember
            member = (await db.execute(select(StarMember).where(
                StarMember.star_id == self.star.id, StarMember.user_id == self.uid("alice")))).scalar_one()
            await db.delete(member)
            await db.commit()
            count = len(await self.series_rows())
            self.assertEqual(await work.extend_series(db, work._now() + timedelta(days=30)), 0)
            self.assertEqual(len(await self.series_rows()), count)
            self.assertTrue((await db.execute(select(StarBookingSeries))).scalar_one().finished)

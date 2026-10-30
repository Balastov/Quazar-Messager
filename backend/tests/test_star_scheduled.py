"""Отложенная отправка в Спутниках: приватность очереди, доставка, отмена и актуальные права."""

import asyncio
from datetime import datetime, timedelta, timezone
from unittest import mock

from pydantic import ValidationError
from sqlalchemy import delete, select, update

from app.api import star_later as later
from app.api import stars
from app.core import scheduler
from app.models.star import ScheduledStarMessage, Star, StarChannel, StarMember
from app.schemas.star import LinkPreview, SendStarMessage
from tests.stars_base import StarsTestBase


def soon(minutes=60):
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


class StarScheduledTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles()
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")
        self.planet = next(c for c in self.star.channels if c.kind == "planet")
        patcher = mock.patch.object(stars, "_push_message", new_callable=mock.AsyncMock)
        self.push = patcher.start()
        self.addCleanup(patcher.stop)
        self.events.clear()

    async def schedule(self, text="Позже", user="alice", channel=None, at=None, **kwargs):
        return await self.call(
            later.schedule_message, self.star.id, (channel or self.sat).id,
            later.ScheduleStarBody(text=text, send_at=at or soon(), **kwargs), user=user,
        )

    async def pending(self, user="alice", channel=None):
        return await self.call(later.list_scheduled, self.star.id, (channel or self.sat).id, user=user)

    async def feed(self):
        return await self.call(
            stars.list_messages, self.star.id, self.sat.id, user="bob", limit=100, before_id=None,
        )

    async def run_job(self, now=None):
        async with self.Session() as db:
            return await scheduler.send_due_star_scheduled(db, now)

    async def change(self, model, row_id, **values):
        async with self.Session() as db:
            await db.execute(update(model).where(model.id == row_id).values(**values))
            await db.commit()

    async def test_queue_is_private_and_message_arrives_once_at_the_chosen_time(self):
        at = soon()
        item = await self.schedule(at=at)
        self.assertEqual([x.id for x in await self.pending()], [item.id])
        self.assertEqual(await self.pending(user="bob"), [])
        self.assertEqual(await self.feed(), [])
        self.assertTrue(self.events)
        self.assertTrue(all(uid == self.users["alice"].id for uid, _ in self.events))
        self.assertEqual(await self.run_job(at - timedelta(seconds=1)), 0)
        self.assertEqual(await self.run_job(at + timedelta(seconds=1)), 1)
        self.assertEqual(await self.run_job(at + timedelta(seconds=2)), 0)
        self.assertEqual([m.text for m in await self.feed()], ["Позже"])
        self.assertEqual(await self.pending(), [])
        self.push.assert_awaited_once()
        self.assertTrue(any(e["type"] == "star_message" for _, e in self.events))

    async def test_only_sender_can_cancel_and_cancellation_prevents_delivery(self):
        item = await self.schedule()
        await self.expect_error(
            404, later.cancel_scheduled, self.star.id, self.sat.id, item.id, user="bob",
        )
        await self.call(later.cancel_scheduled, self.star.id, self.sat.id, item.id, user="alice")
        self.assertEqual(await self.run_job(soon(120)), 0)
        self.assertEqual(await self.feed(), [])

    async def test_reply_preview_and_mentions_survive_scheduling(self):
        reply = await self.call(
            stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="Вопрос"), user="bob",
        )
        preview = LinkPreview(url="https://example.com", title="Пример")
        await self.schedule("Ответ @bob", reply_to_id=reply.id, link_preview=preview)
        await self.run_job(soon(120))
        sent = (await self.feed())[-1]
        self.assertEqual(sent.reply_to.id, reply.id)
        self.assertEqual(sent.link_preview.title, "Пример")
        self.assertEqual(sent.mentions, [self.users["bob"].id])

    async def test_deleted_reply_does_not_prevent_delivery(self):
        reply = await self.call(
            stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="Вопрос"), user="bob",
        )
        await self.schedule(reply_to_id=reply.id)
        await self.call(stars.delete_message, self.star.id, self.sat.id, reply.id, user="bob")
        self.assertEqual(await self.run_job(soon(120)), 1)
        self.assertIsNone((await self.feed())[-1].reply_to)

    async def test_current_membership_is_checked_at_delivery(self):
        await self.schedule()
        async with self.Session() as db:
            await db.execute(delete(StarMember).where(
                StarMember.star_id == self.star.id, StarMember.user_id == self.users["alice"].id,
            ))
            await db.commit()
        self.assertEqual(await self.run_job(soon(120)), 0)
        self.assertEqual(await self.feed(), [])
        self.assertTrue(any(e.get("error") for _, e in self.events))

    async def test_changed_word_filter_is_checked_at_delivery(self):
        await self.schedule("запрет")
        await self.change(Star, self.star.id, banned_words=["запрет"])
        self.assertEqual(await self.run_job(soon(120)), 0)
        self.assertEqual(await self.pending(), [])
        self.assertEqual(await self.feed(), [])

    async def test_announcements_require_admin_and_preserve_acknowledgement(self):
        await self.change(StarChannel, self.sat.id, announcement=True)
        await self.expect_error(
            403, later.schedule_message, self.star.id, self.sat.id,
            later.ScheduleStarBody(text="Объявление", send_at=soon()), user="alice",
        )
        await self.schedule("Объявление", user="owner", ack_required=True)
        self.assertEqual(await self.run_job(soon(120)), 1)
        self.assertTrue((await self.feed())[-1].ack_required)

    async def test_scheduling_cannot_bypass_channel_access_or_use_planets(self):
        body = later.ScheduleStarBody(text="x", send_at=soon())
        await self.expect_error(
            404, later.schedule_message, self.star.id, self.sat.id, body, user="carol",
        )
        await self.expect_error(
            404, later.list_scheduled, self.star.id, self.sat.id, user="carol",
        )
        await self.expect_error(
            400, later.schedule_message, self.star.id, self.planet.id, body, user="alice",
        )

    async def test_time_text_and_pending_limit_are_validated(self):
        for at in (datetime.now(), soon(-1), soon(366 * 24 * 60)):
            await self.expect_error(
                422, later.schedule_message, self.star.id, self.sat.id,
                later.ScheduleStarBody(text="x", send_at=at), user="alice",
            )
        with self.assertRaises(ValidationError):
            later.ScheduleStarBody(text="  ", send_at=soon())
        with mock.patch.object(later, "MAX_PENDING_PER_USER", 1):
            await self.schedule()
            await self.expect_error(
                429, later.schedule_message, self.star.id, self.sat.id,
                later.ScheduleStarBody(text="x", send_at=soon()), user="alice",
            )

    async def test_slow_mode_retries_without_losing_the_message(self):
        await self.change(StarChannel, self.sat.id, slow_mode_sec=60)
        at = soon()
        await self.schedule("Первое", at=at)
        await self.schedule("Второе", at=at)
        self.assertEqual(await self.run_job(at), 1)
        self.assertEqual(len(await self.pending()), 1)
        with mock.patch.object(stars, "_now", return_value=soon(2)):
            self.assertEqual(await self.run_job(at + timedelta(seconds=10)), 1)
        self.assertEqual(len(await self.feed()), 2)
        self.assertEqual(await self.pending(), [])

    async def test_parallel_workers_do_not_send_duplicates(self):
        for text in ("Первое", "Второе", "Третье"):
            await self.schedule(text)
        counts = await asyncio.gather(self.run_job(soon(120)), self.run_job(soon(120)))
        self.assertEqual(sum(counts), 3)
        self.assertCountEqual([m.text for m in await self.feed()], ["Первое", "Второе", "Третье"])
        async with self.Session() as db:
            self.assertEqual(list((await db.execute(select(ScheduledStarMessage))).scalars()), [])

    async def test_failed_transaction_keeps_message_for_retry(self):
        item = await self.schedule()
        with mock.patch.object(stars, "_mentions", side_effect=RuntimeError("temporary failure")):
            with self.assertRaises(RuntimeError):
                await self.run_job(soon(120))
        self.assertEqual([x.id for x in await self.pending()], [item.id])
        self.assertEqual(await self.feed(), [])
        self.assertEqual(await self.run_job(soon(120)), 1)

    async def test_timeout_and_unaccepted_rules_prevent_scheduling(self):
        async with self.Session() as db:
            await db.execute(update(StarMember).where(
                StarMember.star_id == self.star.id, StarMember.user_id == self.users["alice"].id,
            ).values(timeout_until=soon()))
            await db.commit()
        body = later.ScheduleStarBody(text="x", send_at=soon())
        await self.expect_error(403, later.schedule_message, self.star.id, self.sat.id, body, user="alice")
        async with self.Session() as db:
            await db.execute(update(StarMember).where(
                StarMember.star_id == self.star.id, StarMember.user_id == self.users["alice"].id,
            ).values(timeout_until=None, rules_accepted_at=None))
            await db.commit()
        await self.change(Star, self.star.id, rules_text="Примите правила")
        await self.expect_error(403, later.schedule_message, self.star.id, self.sat.id, body, user="alice")

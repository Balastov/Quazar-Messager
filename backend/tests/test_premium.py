"""Quazar Premium: пробный месяц, лимиты Звёзд, выдача в «Чёрной дыре» и напоминания от news_bot."""
from datetime import datetime, timedelta, timezone
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import delete, select

from app.api import premium as premium_api
from app.api import stars as api
from app.core import news, premium
from app.models.news import NewsNotice
from app.models.premium import PremiumGrant
from app.models.user import User
from app.schemas.star import CreateStar, TransferStar
from app.schemas.user import MeOut, UserOut
from tests.stars_base import StarsTestBase


class PremiumTest(StarsTestBase):
    async def fresh(self, name: str) -> User:
        async with self.Session() as db:
            return await db.get(User, self.users[name].id)

    async def info(self, name="alice"):
        async with self.Session() as db:
            return await premium_api.my_premium(me=await db.get(User, self.users[name].id), db=db)

    async def trial(self, name="alice"):
        async with self.Session() as db:
            return await premium_api.start_trial(me=await db.get(User, self.users[name].id), db=db)

    async def create(self, name="alice", count=1):
        for i in range(count):
            await self.make_star(user=name, name=f"Звезда {i}")

    async def create_fails(self, name="alice") -> str:
        error = await self.expect_error(409, api.create_star, CreateStar(name="Лишняя", kind="gaming"), user=name)
        return error.detail

    async def gift(self, name, months):
        async with self.Session() as db:
            await premium.grant(db, await db.get(User, self.users[name].id), months, await db.get(User, self.users["owner"].id))

    async def shift(self, name, days):
        """Перевести часы: конец пробного месяца на days дней от сейчас."""
        async with self.Session() as db:
            grant = (await db.execute(select(PremiumGrant).where(PremiumGrant.user_id == self.users[name].id))).scalars().one()
            grant.ends_at = datetime.now(timezone.utc) + timedelta(days=days)
            user = await db.get(User, self.users[name].id)
            await premium.recompute(db, user)
            await db.commit()

    async def test_free_accounts_create_two_stars_and_see_the_premium_offer(self):
        info = await self.info()
        self.assertEqual((info.active, info.star_limit, info.trial_available, info.trial_days), (False, 2, True, 30))
        await self.create(count=2)
        detail = await self.create_fails()
        self.assertIn("С Premium — до 5", detail)
        self.assertIn("в пробном месяце — до 3", detail)

    async def test_trial_gives_three_stars_once_per_account_and_phone(self):
        info = await self.trial()
        self.assertEqual((info.active, info.kind, info.forever, info.star_limit), (True, "trial", False, 3))
        self.assertAlmostEqual((info.until - datetime.now(timezone.utc)).total_seconds(), 30 * 86400, delta=60)
        self.assertFalse(info.trial_available)
        await self.create(count=3)
        self.assertIn("В пробном Quazar Premium можно создать до 3", await self.create_fails())
        with self.assertRaises(HTTPException) as caught:
            await self.trial()
        self.assertEqual(caught.exception.status_code, 409)
        # Аккаунт удалили и завели заново на тот же номер — второго пробного месяца нет.
        phone = self.users["alice"].phone
        async with self.Session() as db:
            await db.execute(delete(User).where(User.id == self.users["alice"].id))
            again = User(username="alice2", phone=phone, password_hash="x")
            db.add(again)
            await db.commit()
            self.users["alice2"] = again
        self.assertIn("уже использован", (await self.info("alice2")).trial_unavailable_reason)

    async def test_trial_needs_a_confirmed_phone_when_confirmation_is_on(self):
        with mock.patch("app.core.zvonok.required", return_value=True):
            info = await self.info()
            self.assertFalse(info.trial_available)
            self.assertIn("подтвердите номер", info.trial_unavailable_reason)
            async with self.Session() as db:
                (await db.get(User, self.users["alice"].id)).phone_verified_at = datetime.now(timezone.utc)
                await db.commit()
            self.assertTrue((await self.trial()).active)

    async def test_full_premium_gives_five_and_existing_stars_stay_after_it_ends(self):
        await self.gift("alice", 1)
        info = await self.info()
        self.assertEqual((info.kind, info.star_limit, info.forever), ("gift", 5, False))
        # Подарок — не повод для пробного месяца потом.
        self.assertFalse(info.trial_available)
        await self.create(count=5)
        await self.create_fails()
        async with self.Session() as db:
            await premium.revoke(db, await db.get(User, self.users["alice"].id), await db.get(User, self.users["owner"].id))
        info = await self.info()
        self.assertEqual((info.active, info.star_limit, info.owned_stars), (False, 2, 5))
        # Звёзды остались, но новую не создать.
        stars = await self.call(api.list_stars, user="alice")
        self.assertEqual(len(stars), 5)
        await self.create_fails()

    async def test_forever_premium_and_superusers(self):
        await self.gift("bob", None)
        bob = await self.fresh("bob")
        self.assertEqual(premium.state(bob), premium.PremiumState(True, "gift", True, None))
        async with self.Session() as db:
            (await db.get(User, self.users["carol"].id)).is_superuser = True
            await db.commit()
        carol = await self.fresh("carol")
        self.assertEqual(premium.state(carol), premium.PremiumState(True, "superuser", True, None))
        self.assertIsNone(premium.star_limit(carol))
        self.assertTrue(UserOut.model_validate(carol).is_premium)
        me = MeOut.model_validate(carol)
        self.assertEqual((me.premium.kind, me.premium.forever), ("superuser", True))
        self.assertFalse(UserOut.model_validate(await self.fresh("alice")).is_premium)
        self.assertIn("бессрочный", (await self.info("carol")).trial_unavailable_reason)

    async def test_gift_during_trial_wins_and_extends_from_now(self):
        await self.trial()
        await self.gift("alice", 3)
        info = await self.info()
        self.assertEqual((info.kind, info.star_limit), ("gift", 5))
        self.assertAlmostEqual((info.until - datetime.now(timezone.utc)).total_seconds(), 90 * 86400, delta=60)

    async def test_an_expired_trial_brings_the_free_limit_back(self):
        await self.trial()
        await self.create(count=3)
        await self.shift("alice", -1)
        info = await self.info()
        self.assertEqual((info.active, info.star_limit), (False, 2))
        self.assertFalse(UserOut.model_validate(await self.fresh("alice")).is_premium)

    async def remind(self):
        async with self.Session() as db:
            return await premium.remind(db)

    async def notices(self):
        async with self.Session() as db:
            return [n.key.split(":")[0] for n in (await db.execute(select(NewsNotice).order_by(NewsNotice.created_at))).scalars()]

    async def test_news_bot_reminds_three_days_before_on_the_last_day_and_at_the_end(self):
        await self.trial()
        self.assertEqual(await self.remind(), 0)
        await self.shift("alice", 2.5)
        self.assertEqual(await self.remind(), 1)
        self.assertEqual(await self.remind(), 0)
        await self.shift("alice", 0.5)
        await self.remind()
        await self.shift("alice", -0.1)
        await self.remind()
        await self.remind()
        self.assertEqual(await self.notices(), ["premium-trial-3d", "premium-trial-1d", "premium-trial-ended"])
        async with self.Session() as db:
            await news.bot_user(db)
            texts = [n.payload for n in (await db.execute(select(NewsNotice).order_by(NewsNotice.created_at))).scalars()]
        self.assertIn("через 3 дня", texts[0])
        self.assertIn("последний день", texts[1])
        self.assertIn("Теперь можно создавать до 2 Звёзд", texts[2])

    async def test_no_trial_reminders_after_buying_or_gift(self):
        await self.trial()
        await self.shift("alice", 2)
        await self.gift("alice", 1)
        self.assertEqual(await self.remind(), 0)

    async def test_transfer_respects_the_recipients_limit(self):
        star = await self.make_star(user="owner")
        await self.join(star.id, "bob")
        await self.create("bob", 2)
        error = await self.expect_error(409, api.transfer_star, star.id, TransferStar(user_id=self.users["bob"].id), user="owner")
        self.assertIn("2 своих Звезды", error.detail)
        await self.gift("bob", 1)
        await self.call(api.transfer_star, star.id, TransferStar(user_id=self.users["bob"].id), user="owner")

    async def test_limits_endpoint_reports_the_personal_limit(self):
        self.assertEqual((await self.call(api.get_limits, user="alice")).max_owned_stars, 2)
        await self.gift("alice", 1)
        async with self.Session() as db:
            fresh = await db.get(User, self.users["alice"].id)
            self.assertEqual((await api.get_limits(current_user=fresh, db=db)).max_owned_stars, 5)

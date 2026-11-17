"""Вход по коду от Quazar_Admin_bot. Нужна PostgreSQL (см. stars_base)."""

import re
from datetime import timedelta
from unittest import mock

import httpx
from sqlalchemy import select, update

from app.core import device_sessions as sessions, login_codes
from app.core.database import get_db
from app.core.security import create_access_token, token_claims
from app.main import app
from app.models.device import DeviceSession, LoginCode
from app.models.message import Message
from app.models.user import User
from tests.stars_base import StarsTestBase

AGENT = "Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537"


class LoginCodeTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.alice = self.users["alice"]
        async with self.Session() as db:
            # Телефон, где Алиса уже вошла: туда и придёт код.
            await sessions.ensure(db, create_access_token(self.alice.id), self.alice, "Chrome/1 Android")

        async def database():
            async with self.Session() as db:
                yield db

        app.dependency_overrides[get_db] = database
        self.addCleanup(app.dependency_overrides.clear)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://quazar-msg.ru",
                                        headers={"user-agent": AGENT})
        self.addAsyncCleanup(self.client.aclose)

    async def start(self, phone=None):
        return await self.client.post("/auth/code-login/start", json={"phone": phone or self.alice.phone})

    async def complete(self, token, code):
        return await self.client.post("/auth/code-login/complete", json={"login_token": token, "code": code})

    async def bot_messages(self):
        async with self.Session() as db:
            rows = (await db.execute(select(Message).where(Message.sender_id != self.alice.id)
                                     .order_by(Message.created_at))).scalars().all()
        return [row.payload for row in rows]

    async def last_code(self):
        found = re.search(r"\*\*(\d{5})\*\*", (await self.bot_messages())[-1])
        self.assertIsNotNone(found)
        return found.group(1)

    async def age_codes(self, seconds):
        """Сдвинуть уже выданные коды в прошлое — вместо ожидания."""
        async with self.Session() as db:
            await db.execute(update(LoginCode).values(created_at=LoginCode.created_at - timedelta(seconds=seconds)))
            await db.commit()

    async def test_code_arrives_from_the_bot_and_signs_in_once(self):
        response = await self.start("+7 (900) 000-00-03")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        data = response.json()
        self.assertNotIn("code", data)
        text = (await self.bot_messages())[-1]
        self.assertIn("Chrome · Windows", text)
        self.assertIn("Никому не сообщайте", text)
        code = await self.last_code()
        async with self.Session() as db:
            row = (await db.execute(select(LoginCode))).scalar_one()
            self.assertNotIn(code, row.code_hash)
            self.assertNotEqual(row.token_hash, data["login_token"])

        response = await self.complete(data["login_token"], f"{code[:2]} {code[2:]}")
        self.assertEqual(response.status_code, 200, response.text)
        claims = token_claims(response.json()["access_token"])
        self.assertEqual(claims["sub"], self.alice.id)
        async with self.Session() as db:
            device = await db.get(DeviceSession, claims["sid"])
            self.assertEqual(device.name, "Chrome · Windows")
        # Код из чата убран, вместо него — отметка о входе.
        notice = (await self.bot_messages())[-1]
        self.assertNotIn(code, notice)
        self.assertIn("выполнен вход", notice)
        self.assertTrue(any(event.get("type") == "message_edited" for _, event in self.events))

        again = await self.complete(data["login_token"], code)
        self.assertEqual(again.status_code, 410)

    async def test_three_wrong_codes_lock_the_attempt(self):
        token = (await self.start()).json()["login_token"]
        code = await self.last_code()
        wrong = f"{(int(code) + 1) % 100000:05d}"
        first = await self.complete(token, wrong)
        self.assertEqual(first.status_code, 400)
        self.assertIn("Осталось попыток: 2", first.json()["detail"])
        self.assertEqual((await self.complete(token, wrong)).status_code, 400)
        self.assertEqual((await self.complete(token, wrong)).status_code, 429)
        # Даже верный код после блокировки не пускает.
        self.assertEqual((await self.complete(token, code)).status_code, 429)

    async def test_only_the_latest_code_works_and_resend_waits_a_minute(self):
        old = (await self.start()).json()["login_token"]
        old_code = await self.last_code()
        too_soon = await self.start()
        self.assertEqual(too_soon.status_code, 429)
        self.assertIn("через", too_soon.json()["detail"])
        await self.age_codes(61)
        new = (await self.start()).json()["login_token"]
        self.assertEqual((await self.complete(old, old_code)).status_code, 410)
        self.assertEqual((await self.complete(new, await self.last_code())).status_code, 200)

    async def test_ip_limit_comes_first_then_the_hourly_account_limit(self):
        for _ in range(5):
            self.assertEqual((await self.start()).status_code, 200)
            await self.age_codes(61)
        self.assertIn("Повторите через минуту", (await self.start()).json()["detail"])

    async def test_hourly_limit(self):
        async def no_ip_limit(*args, **kwargs):
            return None

        patcher = mock.patch.object(login_codes, "rate_limit", no_ip_limit)
        patcher.start()
        self.addCleanup(patcher.stop)
        for _ in range(login_codes.HOURLY_CODES):
            self.assertEqual((await self.start()).status_code, 200)
            await self.age_codes(61)
        refused = await self.start()
        self.assertEqual(refused.status_code, 429)
        self.assertIn("Слишком много запросов", refused.json()["detail"])

    async def test_daily_wrong_codes_cap_stops_guessing(self):
        async with self.Session() as db:
            db.add(LoginCode(user_id=self.alice.id, token_hash="x" * 64, code_hash="y" * 64, device_name="?",
                             ip_hash="z" * 64, state="locked", attempts=login_codes.DAILY_FAILURES,
                             created_at=login_codes.now() - timedelta(hours=2),
                             expires_at=login_codes.now() - timedelta(hours=2)))
            await db.commit()
        refused = await self.start()
        self.assertEqual(refused.status_code, 429)
        self.assertIn("неверных кодов", refused.json()["detail"])

    async def test_who_cannot_get_a_code(self):
        self.assertEqual((await self.start("+79990001122")).status_code, 400)
        # Bob нигде не вошёл — код некому показать.
        nobody = await self.start(self.users["bob"].phone)
        self.assertEqual(nobody.status_code, 409)
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.alice.id).values(blocked_at=login_codes.now()))
            await db.commit()
        self.assertEqual((await self.start()).status_code, 400)

    async def test_signed_out_devices_do_not_count(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.alice.id)
                             .values(sessions_revoked_at=login_codes.now() + timedelta(seconds=1)))
            await db.commit()
        self.assertEqual((await self.start()).status_code, 409)

    async def test_code_must_be_five_digits(self):
        token = (await self.start()).json()["login_token"]
        self.assertEqual((await self.complete(token, "1234")).status_code, 422)
        self.assertEqual((await self.complete(token, "١٢٣٤٥")).status_code, 422)

"""Иностранные номера: код подтверждения в Telegram через Telegram Gateway."""

import asyncio
import json
import unittest
from datetime import timedelta
from unittest import mock

import httpx
from fastapi import FastAPI
from sqlalchemy import select, update

from app.api import auth, contacts, phone_verification as api, users
from app.core import phone_verification as verification, telegram_gateway, zvonok
from app.core.config import settings
from app.core.database import get_db
from app.core.phone import normalize_phone, phone_region, uses_call_check
from app.core.security import create_access_token
from app.models.phone_verification import PhoneVerification
from app.models.user import User
from tests.stars_base import StarsTestBase

UK = "+447911123456"


class NormalizePhoneTest(unittest.TestCase):
    def test_russian_inputs_keep_the_old_result(self):
        for raw in ("+7 (999) 123-45-67", "89991234567", "79991234567", "9991234567"):
            self.assertEqual(normalize_phone(raw), "+79991234567")

    def test_existing_plus7_accounts_stay_valid_even_outside_the_number_database(self):
        self.assertEqual(normalize_phone("+7 000 123-45-67"), "+70001234567")

    def test_foreign_numbers_need_a_country_code_or_a_region(self):
        self.assertEqual(normalize_phone("+44 7911 123456"), UK)
        self.assertEqual(normalize_phone("0044 7911 123456"), UK)
        self.assertEqual(normalize_phone("07911 123456", "GB"), UK)
        self.assertEqual(normalize_phone("+1 (202) 555-0143"), "+12025550143")
        with self.assertRaises(ValueError):
            normalize_phone("07911 123456")

    def test_invalid_numbers_are_rejected(self):
        for raw in ("", "abc", "12345", "+1234", "+44 1", "+999 123456789", "+1" + "2" * 20):
            with self.assertRaises(ValueError):
                normalize_phone(raw)

    def test_region_and_check_method(self):
        self.assertEqual(phone_region("+77011234567"), "KZ")
        self.assertEqual(phone_region("+79991234567"), "RU")
        self.assertEqual(phone_region("+12025550143"), "US")
        self.assertEqual(phone_region("+447700900123"), "GB")  # вне диапазонов — по коду страны
        self.assertTrue(uses_call_check("+77011234567"))
        self.assertFalse(uses_call_check(UK))


class TelegramCodeTest(StarsTestBase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 1
        await super().asyncSetUp()
        patcher = mock.patch.multiple(settings, ZVONOK_API_KEY="test-secret", ZVONOK_CAMPAIGN_ID="1280695808", ZVONOK_DAILY_LIMIT=500,
                                      TELEGRAM_GATEWAY_TOKEN="tg-secret", TELEGRAM_GATEWAY_SENDER="", TELEGRAM_GATEWAY_DAILY_LIMIT=300)
        patcher.start(); self.addCleanup(patcher.stop)
        self.codes = []
        async def send(phone, code, ttl):
            self.codes.append(code)
            return f"req{len(self.codes)}"
        self.send = mock.AsyncMock(side_effect=send)
        self.report = mock.AsyncMock()
        self.zvonok_create = mock.AsyncMock(side_effect=AssertionError("иностранный номер не должен звонить"))
        for target, name, value in ((telegram_gateway, "send_code", self.send), (telegram_gateway, "report_code", self.report),
                                    (zvonok, "create", self.zvonok_create)):
            patcher = mock.patch.object(target, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        self.app = FastAPI()
        for router in (api.router, auth.router, users.router, contacts.router):
            self.app.include_router(router)
        async def database():
            async with self.Session() as db: yield db
        self.app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def start(self, phone="+44 7911 123456"):
        return await self.client.post("/auth/phone-verification/start", json={"phone": phone})

    async def check(self, token, code=None):
        body = {"verification_token": token}
        if code is not None:
            body["code"] = code
        return await self.client.post("/auth/phone-verification/status", json=body)

    async def test_foreign_number_gets_a_telegram_code_and_registers(self):
        start = await self.start()
        self.assertEqual(start.status_code, 200, start.text)
        data = start.json()
        self.assertEqual((data["phone"], data["method"], data["state"], data["call_phone"]), (UK, "telegram", "pending", None))
        self.send.assert_awaited_once()
        phone, code, ttl = self.send.await_args.args
        self.assertEqual((phone, len(code), ttl), (UK, 6, 300))
        self.assertNotIn(code, start.text)
        token = data["verification_token"]
        async with self.Session() as db:
            attempt = (await db.execute(select(PhoneVerification))).scalar_one()
            self.assertEqual((attempt.method, attempt.call_id), ("telegram", "tg:req1"))
            self.assertNotIn(code, attempt.code_hash)
        self.assertEqual((await self.check(token)).json()["state"], "pending")
        verified = await self.check(token, code[:3] + " " + code[3:])
        self.assertEqual(verified.json()["state"], "verified", verified.text)
        await asyncio.sleep(0)
        self.report.assert_awaited_once_with("req1", code)
        register = await self.client.post("/auth/register", json={
            "username": "abroad", "phone": "+44 7911 123456", "phone_discoverable": True, "phone_verification_token": token})
        self.assertEqual(register.status_code, 201, register.text)
        async with self.Session() as db:
            user = (await db.execute(select(User).where(User.username == "abroad"))).scalar_one()
            self.assertEqual(user.phone, UK)
            self.assertIsNotNone(user.phone_verified_at)

    async def test_wrong_codes_are_limited_and_cannot_be_used_after(self):
        token = (await self.start()).json()["verification_token"]
        code = self.codes[0]
        wrong = "000000" if code != "000000" else "111111"
        for left in (4, 3, 2, 1):
            response = await self.check(token, wrong)
            self.assertEqual(response.status_code, 400)
            self.assertIn(str(left), response.json()["detail"])
        self.assertEqual((await self.check(token, wrong)).json()["state"], "failed")
        self.assertEqual((await self.check(token, code)).json()["state"], "failed")
        register = await self.client.post("/auth/register", json={
            "username": "abroad", "phone": UK, "phone_discoverable": False, "phone_verification_token": token})
        self.assertEqual(register.status_code, 400)

    async def test_code_is_bound_to_its_own_browser_token(self):
        first = (await self.start()).json()["verification_token"]
        async with self.Session() as db:
            await db.execute(update(PhoneVerification).values(created_at=verification.now() - timedelta(minutes=2)))
            await db.commit()
        second = (await self.start()).json()["verification_token"]
        self.assertEqual((await self.check(second, self.codes[0])).status_code, 400)
        self.assertEqual((await self.check(first, self.codes[0])).json()["state"], "verified")

    async def test_expired_code_is_not_accepted(self):
        token = (await self.start()).json()["verification_token"]
        async with self.Session() as db:
            await db.execute(update(PhoneVerification).values(expires_at=verification.now() - timedelta(seconds=1)))
            await db.commit()
        self.assertEqual((await self.check(token, self.codes[0])).json()["state"], "expired")

    async def test_resend_waits_a_minute_and_daily_limit_is_separate_from_calls(self):
        self.assertEqual((await self.start()).status_code, 200)
        self.assertEqual((await self.start()).status_code, 429)
        with mock.patch.object(settings, "TELEGRAM_GATEWAY_DAILY_LIMIT", 1):
            response = await self.start("+12025550143")
            self.assertEqual(response.status_code, 429)
            self.assertIn("Дневной лимит", response.json()["detail"])
        self.assertEqual(self.send.await_count, 1)

    async def test_without_gateway_token_foreign_numbers_cannot_start_but_russian_still_call(self):
        with mock.patch.object(settings, "TELEGRAM_GATEWAY_TOKEN", ""):
            response = await self.start()
            self.assertEqual(response.status_code, 503)
            self.assertIn("+7", response.json()["detail"])
            self.zvonok_create.side_effect = None
            self.zvonok_create.return_value = zvonok.Confirmation("1", "+79863067372", verification.now())
            russian = await self.start("+7 916 000-11-22")
            self.assertEqual((russian.status_code, russian.json()["method"]), (200, "call"))
        self.send.assert_not_awaited()

    async def test_number_without_telegram_is_reported_and_not_retried_immediately(self):
        self.send.side_effect = telegram_gateway.Undeliverable()
        response = await self.start()
        self.assertEqual(response.status_code, 400)
        self.assertIn("Telegram", response.json()["detail"])
        self.assertEqual((await self.start()).status_code, 429)

    async def test_code_is_rejected_for_call_checks(self):
        self.zvonok_create.side_effect = None
        self.zvonok_create.return_value = zvonok.Confirmation("1", "+79863067372", verification.now())
        token = (await self.start("+79160001122")).json()["verification_token"]
        self.assertEqual((await self.check(token, "123456")).status_code, 400)

    async def test_account_owner_with_foreign_number_confirms_by_code(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.users["alice"].id).values(phone=UK, phone_verified_at=None))
            await db.commit()
        headers = {"Authorization": "Bearer " + create_access_token(self.users["alice"].id)}
        start = await self.client.post("/users/me/phone-verification/start", headers=headers)
        self.assertEqual((start.status_code, start.json()["method"]), (200, "telegram"), start.text)
        status = await self.client.post("/users/me/phone-verification/status", headers=headers,
                                        json={"verification_token": start.json()["verification_token"], "code": self.codes[0]})
        self.assertEqual(status.json()["state"], "verified")
        self.assertTrue(status.json()["access_token"])

    async def test_phonebook_reads_local_numbers_by_the_owner_country_and_russian_fallback(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.users["alice"].id).values(phone="+447700900123"))
            await db.execute(update(User).where(User.id == self.users["bob"].id).values(phone=UK, phone_discoverable=True))
            await db.execute(update(User).where(User.id == self.users["carol"].id).values(phone="+79991234567", phone_discoverable=True))
            await db.commit()
        headers = {"Authorization": "Bearer " + create_access_token(self.users["alice"].id)}
        response = await self.client.post("/contacts/sync", headers=headers, json={"mode": "replace", "contacts": [
            {"name": "Bob UK", "phones": ["07911 123456"]}, {"name": "Кэрол", "phones": ["8 999 123-45-67"]}]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(sorted(c["name"] for c in response.json()["contacts"]), ["Bob UK", "Кэрол"])

    async def test_search_finds_a_foreign_number_only_in_full(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.users["bob"].id).values(phone=UK, phone_discoverable=True))
            await db.commit()
        headers = {"Authorization": "Bearer " + create_access_token(self.users["alice"].id)}
        found = await self.client.get("/users/search", params={"q": "+44 7911 123456"}, headers=headers)
        self.assertEqual([u["id"] for u in found.json()], [self.users["bob"].id])
        partial = await self.client.get("/users/search", params={"q": "+44 7911"}, headers=headers)
        self.assertEqual(partial.json(), [])


class GatewayClientTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        patcher = mock.patch.multiple(settings, TELEGRAM_GATEWAY_TOKEN="tg-secret", TELEGRAM_GATEWAY_SENDER="@quazar")
        patcher.start(); self.addCleanup(patcher.stop)

    async def test_sends_own_code_with_ttl_bearer_token_and_sender(self):
        seen = {}
        def handler(request):
            seen.update(url=str(request.url), auth=request.headers["authorization"], body=json.loads(request.content))
            return httpx.Response(200, json={"ok": True, "result": {"request_id": "abc", "phone_number": UK, "request_cost": 0.01}})
        request_id = await telegram_gateway.send_code(UK, "123456", 300, transport=httpx.MockTransport(handler))
        self.assertEqual(request_id, "abc")
        self.assertEqual(seen["url"], "https://gatewayapi.telegram.org/sendVerificationMessage")
        self.assertEqual(seen["auth"], "Bearer tg-secret")
        self.assertEqual(seen["body"], {"phone_number": UK, "code": "123456", "ttl": 300, "sender_username": "quazar"})

    async def test_errors_split_into_number_problems_and_our_problems(self):
        def reply(error, status=400):
            return httpx.MockTransport(lambda request: httpx.Response(status, json={"ok": False, "error": error}))
        with self.assertRaises(telegram_gateway.Undeliverable):
            await telegram_gateway.send_code(UK, "123456", 300, transport=reply("PHONE_NUMBER_NOT_FOUND"))
        for error in ("ACCESS_TOKEN_INVALID", "BALANCE_NOT_ENOUGH"):
            with self.assertRaises(telegram_gateway.ProviderError) as caught:
                await telegram_gateway.send_code(UK, "123456", 300, transport=reply(error))
            self.assertNotIsInstance(caught.exception, telegram_gateway.Undeliverable)
        with self.assertRaises(telegram_gateway.ProviderError) as caught:
            await telegram_gateway.send_code(UK, "123456", 300, transport=reply("SOMETHING", 502))
        self.assertNotIsInstance(caught.exception, telegram_gateway.Undeliverable)
        with self.assertRaises(telegram_gateway.ProviderError):
            await telegram_gateway.send_code(UK, "123456", 300, transport=httpx.MockTransport(lambda r: httpx.Response(200, text="<html>")))

    async def test_report_never_fails_verification(self):
        await telegram_gateway.report_code("abc", "123456", transport=httpx.MockTransport(lambda r: httpx.Response(500)))

    async def test_unconfigured_client_does_not_call_out(self):
        with mock.patch.object(settings, "TELEGRAM_GATEWAY_TOKEN", " "):
            self.assertFalse(telegram_gateway.configured())
            with self.assertRaises(telegram_gateway.ProviderError):
                await telegram_gateway.send_code(UK, "123456", 300, transport=httpx.MockTransport(lambda r: 1 / 0))


if __name__ == "__main__":
    unittest.main()

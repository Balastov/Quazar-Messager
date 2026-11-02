import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qs

import httpx
from fastapi import FastAPI
from sqlalchemy import select, update

from app.api import auth, oauth, phone_verification as api, users
from app.core import phone_verification as verification, zvonok
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.phone_verification import PhoneVerification
from app.models.user import OAuthFlow, User
from tests.stars_base import StarsTestBase

PHONE = "+79160001122"
DESTINATION = "+79863067372"


class PhoneVerificationTest(StarsTestBase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 1
        await super().asyncSetUp()
        patcher = mock.patch.multiple(settings, ZVONOK_API_KEY="test-secret", ZVONOK_CAMPAIGN_ID="1280695808", ZVONOK_DAILY_LIMIT=500)
        patcher.start(); self.addCleanup(patcher.stop)
        self.sequence = 0
        async def create(phone):
            self.sequence += 1
            return zvonok.Confirmation(str(self.sequence), DESTINATION, verification.now())
        self.create = mock.AsyncMock(side_effect=create)
        self.result = mock.AsyncMock(return_value="pending")
        for name, value in (("create", self.create), ("result", self.result)):
            patcher = mock.patch.object(zvonok, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.object(verification, "POLL_SECONDS", 0)
        patcher.start(); self.addCleanup(patcher.stop)
        self.app = FastAPI()
        for router in (api.router, auth.router, oauth.router, users.router): self.app.include_router(router)
        async def database():
            async with self.Session() as db: yield db
        self.app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    def bearer(self, who="alice"):
        return {"Authorization": "Bearer " + create_access_token(self.users[who].id)}

    async def start(self, phone=PHONE):
        return await self.client.post("/auth/phone-verification/start", json={"phone": phone})

    async def check(self, token, account=False, who="alice"):
        return await self.client.post("/users/me/phone-verification/status" if account else "/auth/phone-verification/status",
            json={"verification_token": token}, headers=self.bearer(who) if account else {})

    async def verified(self):
        start = await self.start()
        self.assertEqual(start.status_code, 200, start.text)
        token = start.json()["verification_token"]
        self.result.return_value = "verified"
        self.assertEqual((await self.check(token)).json()["state"], "verified")
        return token

    def registration(self, **extra):
        return {"username": "new_user", "phone": PHONE, "password": "password123", "phone_discoverable": False, **extra}

    async def test_creates_incoming_check_and_stores_only_a_hash_of_the_browser_token(self):
        response = await self.start()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual((data["phone"], data["call_phone"], data["state"]), (PHONE, DESTINATION, "pending"))
        self.assertNotIn("test-secret", response.text)
        self.assertNotIn("call_id", data)
        async with self.Session() as db:
            attempt = (await db.execute(select(PhoneVerification))).scalar_one()
            self.assertEqual(attempt.token_hash, verification.digest(data["verification_token"]))
            self.assertNotEqual(attempt.token_hash, data["verification_token"])

    async def test_cannot_register_without_a_verified_phone(self):
        no_proof = await self.client.post("/auth/register", json=self.registration())
        self.assertEqual(no_proof.status_code, 400)
        response = await self.start()
        pending = await self.client.post("/auth/register", json=self.registration(phone_verification_token=response.json()["verification_token"]))
        self.assertEqual(pending.status_code, 400)

    async def test_successful_proof_is_bound_to_phone_and_consumed_atomically_with_account(self):
        token = await self.verified()
        wrong_phone = await self.client.post("/auth/register", json=self.registration(phone="+79160001123", phone_verification_token=token))
        self.assertEqual(wrong_phone.status_code, 400)
        response = await self.client.post("/auth/register", json=self.registration(phone_verification_token=token))
        self.assertEqual(response.status_code, 201, response.text)
        me = await self.client.get("/users/me", headers={"Authorization": "Bearer " + response.json()["access_token"]})
        self.assertIsNotNone(me.json()["phone_verified_at"])
        self.assertEqual((await self.check(token)).json()["state"], "expired")
        async with self.Session() as db:
            attempt = (await db.execute(select(PhoneVerification))).scalar_one()
            self.assertIsNotNone(attempt.used_at)

    async def test_expired_proof_is_not_accepted_even_if_it_was_verified(self):
        token = await self.verified()
        async with self.Session() as db:
            await db.execute(update(PhoneVerification).values(expires_at=verification.now() - timedelta(seconds=1)))
            await db.commit()
        self.assertEqual((await self.check(token)).json()["state"], "expired")
        response = await self.client.post("/auth/register", json=self.registration(phone_verification_token=token))
        self.assertEqual(response.status_code, 400)

    async def test_current_account_verification_is_private_and_does_not_become_a_registration_proof(self):
        start = await self.client.post("/users/me/phone-verification/start", headers=self.bearer())
        self.assertEqual(start.status_code, 200)
        token = start.json()["verification_token"]
        self.assertEqual((await self.check(token)).status_code, 404)
        self.assertEqual((await self.check(token, account=True, who="bob")).status_code, 404)
        self.result.return_value = "verified"
        self.assertEqual((await self.check(token, account=True)).json()["state"], "verified")
        me = await self.client.get("/users/me", headers=self.bearer())
        self.assertIsNotNone(me.json()["phone_verified_at"])
        async with self.Session() as db:
            with self.assertRaises(Exception) as error:
                await verification.consume(db, self.users["alice"].phone, token)
            self.assertEqual(error.exception.status_code, 400)

    async def test_duplicate_and_concurrent_starts_do_not_create_extra_provider_requests(self):
        responses = await asyncio.gather(self.start(), self.start())
        self.assertEqual(sorted(r.status_code for r in responses), [200, 429])
        self.create.assert_awaited_once()

    async def test_provider_failure_does_not_allow_registration_or_immediate_retry(self):
        self.create.side_effect = zvonok.ProviderError()
        response = await self.start()
        self.assertEqual(response.status_code, 503)
        self.assertEqual((await self.start()).status_code, 429)
        self.assertEqual((await self.client.post("/auth/register", json=self.registration())).status_code, 400)

    async def test_daily_limit_is_persistent_and_prevents_provider_call(self):
        with mock.patch.object(settings, "ZVONOK_DAILY_LIMIT", 0):
            self.assertEqual((await self.start()).status_code, 429)
        self.create.assert_not_awaited()

    async def test_polling_is_throttled_before_contacting_provider(self):
        token = (await self.start()).json()["verification_token"]
        with mock.patch.object(verification, "POLL_SECONDS", 4):
            await self.check(token); await self.check(token)
        self.result.assert_awaited_once()

    async def test_existing_remote_call_cannot_issue_a_second_browser_proof(self):
        self.create.return_value = zvonok.Confirmation("old-call", DESTINATION, verification.now() - timedelta(minutes=3))
        self.create.side_effect = None
        response = await self.start()
        self.assertEqual(response.status_code, 409)

    async def test_yandex_registration_also_requires_phone_proof(self):
        async with self.Session() as db:
            db.add(OAuthFlow(state="state", provider="yandex", verifier="pkce", mode="login", client="web", handoff="handoff",
                profile={"id": "new-yandex-subject"}, expires_at=verification.now() + timedelta(hours=1)))
            await db.commit()
        body = {"code": "handoff", "username": "new_user", "phone": PHONE, "phone_discoverable": False}
        self.assertEqual((await self.client.post("/auth/yandex/complete", json=body)).status_code, 400)
        body["phone_verification_token"] = await self.verified()
        response = await self.client.post("/auth/yandex/complete", json=body)
        self.assertEqual(response.status_code, 201, response.text)

    async def test_unconfigured_environment_preserves_existing_registration(self):
        with mock.patch.multiple(settings, ZVONOK_API_KEY="", ZVONOK_CAMPAIGN_ID=""):
            response = await self.client.post("/auth/register", json=self.registration())
        self.assertEqual(response.status_code, 201)


class ZvonokContractTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patcher = mock.patch.multiple(settings, ZVONOK_API_KEY="test-secret", ZVONOK_CAMPAIGN_ID="1280695808")
        patcher.start(); self.addCleanup(patcher.stop)

    async def test_actual_incoming_response_uses_allowed_phones_not_the_customer_phone(self):
        async def handler(request):
            self.assertEqual(request.method, "POST")
            self.assertNotIn("public_key", request.url.query.decode())
            self.assertEqual(parse_qs(request.content.decode())["phone"], [PHONE])
            return httpx.Response(200, json={"status": "ok", "data": {"call_id": 123, "phone": PHONE, "pincode": "",
                "created": verification.now().isoformat(), "allowed_phones_for_call": [DESTINATION, "+79862667785"]}})
        result = await zvonok.create(PHONE, transport=httpx.MockTransport(handler))
        self.assertEqual((result.call_id, result.call_phone), ("123", DESTINATION))

    async def test_wrong_campaign_response_is_rejected_instead_of_showing_a_pin_or_the_customer_phone(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"status": "ok", "data": {
            "call_id": 123, "phone": PHONE, "pincode": "1234", "created": verification.now().isoformat()}}))
        with self.assertRaises(zvonok.ProviderError): await zvonok.create(PHONE, transport=transport)

    async def test_only_explicit_pincode_ok_from_the_matching_call_and_phone_is_success(self):
        for call_status, expected in (("pincode_ok", "verified"), ("in_process", "pending"), ("user", "pending"), ("compl_finished", "pending"), ("expires", "failed")):
            transport = httpx.MockTransport(lambda request: httpx.Response(200, json=[{
                "call_id": 123, "phone": PHONE, "call_status": call_status, "status": "pincode_ok"}]))
            self.assertEqual(await zvonok.result("123", PHONE, transport=transport), expected)
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json=[{
            "call_id": 124, "phone": PHONE, "call_status": "pincode_ok"}]))
        with self.assertRaises(zvonok.ProviderError): await zvonok.result("123", PHONE, transport=transport)

    async def test_http_logs_redact_the_query_key(self):
        import logging
        record = logging.LogRecord("httpx", logging.INFO, "", 0, "GET %s", ("https://zvonok.com/call/?public_key=test-secret&call_id=123",), None)
        zvonok._RedactKey().filter(record)
        self.assertNotIn("test-secret", record.getMessage())


class ProxyAddressTest(unittest.TestCase):
    def request(self, value):
        from starlette.requests import Request
        return Request({"type": "http", "client": ("172.18.0.1", 1234), "headers": [(b"x-real-ip", value.encode())]})

    def test_direct_development_does_not_trust_visitor_headers(self):
        with mock.patch.object(settings, "TRUST_PROXY_REAL_IP", False):
            self.assertEqual(api.client_ip(self.request("8.8.8.8")), "172.18.0.1")

    def test_production_uses_overwritten_nginx_ip_and_rejects_malformed_headers(self):
        with mock.patch.object(settings, "TRUST_PROXY_REAL_IP", True):
            self.assertEqual(api.client_ip(self.request("8.8.8.8")), "8.8.8.8")
            self.assertEqual(api.client_ip(self.request("spoofed, 8.8.8.8")), "172.18.0.1")

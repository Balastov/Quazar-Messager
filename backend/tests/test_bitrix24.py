import json
import asyncio
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import httpx
from cryptography.fernet import Fernet
from fastapi import FastAPI
from sqlalchemy import select

from app.api import bitrix24 as api
from app.core import bitrix24 as b24
from app.core.config import settings
from app.core.database import get_db
from app.models.bitrix24 import BitrixCredential, BitrixHandoff, BitrixInstallation
from tests.stars_base import StarsTestBase


class Bitrix24Test(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.key = Fernet.generate_key().decode()
        patcher = mock.patch.multiple(settings,
            BITRIX24_PORTAL_URL="https://is4business.bitrix24.ru", BITRIX24_CLIENT_ID="local.test",
            BITRIX24_CLIENT_SECRET="test-client-secret", BITRIX24_TOKEN_KEY=self.key)
        patcher.start(); self.addCleanup(patcher.stop)
        self.requests = []
        self.employee = "27"
        self.admin = True
        self.active = True
        self.token_override = {}
        self.app_code = "local.test"
        self.profile_id = None
        patcher = mock.patch.object(b24, "transport", httpx.MockTransport(self.upstream))
        patcher.start(); self.addCleanup(patcher.stop)
        app = FastAPI(); app.include_router(api.router)
        async def database():
            async with self.Session() as db: yield db
        app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://quazar-msg.ru")
        self.addAsyncCleanup(self.client.aclose)

    def upstream(self, request):
        self.requests.append(request)
        if str(request.url) == b24.TOKEN_URL:
            fields = parse_qs(request.content.decode())
            self.assertEqual(fields["client_secret"], ["test-client-secret"])
            return httpx.Response(200, json={"access_token": "private-access", "refresh_token": "private-refresh",
                "user_id": self.employee, "member_id": "member-one", "expires_in": 3600,
                "client_endpoint": "https://is4business.bitrix24.ru/rest/", **self.token_override})
        if request.url.path == "/rest/app.info.json": result = {"CODE": self.app_code}
        elif request.url.path == "/rest/user.current.json":
            result = {"ID": self.profile_id or self.employee, "NAME": "Иван", "LAST_NAME": "Тестов", "ACTIVE": self.active}
        elif request.url.path == "/rest/user.admin.json": result = self.admin
        else: self.fail("Unexpected upstream request: " + str(request.url))
        return httpx.Response(200, json={"result": result})

    async def launch(self, mode="install", **extra):
        return await self.client.post(f"/integrations/bitrix24/{mode}", data={
            "DOMAIN": "is4business.bitrix24.ru", "APP_SID": "frame-sid", "member_id": "member-one",
            "APPLICATION_TOKEN": "test-application-token", "REFRESH_ID": "test-refresh-token", **extra})

    async def exchange(self, response):
        code = parse_qs(urlsplit(response.headers["location"]).fragment)["code"][0]
        return await self.client.post("/integrations/bitrix24/exchange", json={"code": code})

    async def test_install_exchange_is_single_use_and_exposes_no_oauth_or_quazar_session(self):
        response = await self.launch()
        self.assertEqual(response.status_code, 303, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("private-", response.headers["location"])
        exchanged = await self.exchange(response)
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        self.assertEqual(exchanged.headers["cache-control"], "no-store")
        self.assertEqual(exchanged.json(), {"portal": b24.origin(), "employee_id": "27",
            "display_name": "Иван Тестов", "mode": "install", "account_linking_available": False})
        self.assertEqual((await self.exchange(response)).status_code, 410)
        async with self.Session() as db:
            row = (await db.execute(select(BitrixCredential))).scalar_one()
            self.assertNotIn("private-access", row.tokens)
            self.assertEqual(json.loads(Fernet(self.key).decrypt(row.tokens.encode())),
                {"access_token": "private-access", "refresh_token": "private-refresh"})
            connection = (await db.execute(select(BitrixInstallation))).scalar_one()
            self.assertNotEqual(connection.application_token_hash, "test-application-token")

    async def test_employee_launch_is_separate_from_installer_and_ignores_forged_user_id(self):
        self.assertEqual((await self.launch()).status_code, 303)
        self.employee = "28"; self.admin = False
        response = await self.launch("launch", user_id="1", AUTH_ID="not-used", client_endpoint="http://127.0.0.1/")
        self.assertEqual(response.status_code, 303, response.text)
        self.assertEqual((await self.exchange(response)).json()["employee_id"], "28")
        self.assertTrue(all(r.url.host in {"is4business.bitrix24.ru", "oauth.bitrix24.tech"} for r in self.requests))
        async with self.Session() as db:
            self.assertEqual(len((await db.execute(select(BitrixCredential))).scalars().all()), 2)

    async def test_foreign_domain_application_token_and_uninstalled_launch_do_not_call_upstream(self):
        self.assertEqual((await self.launch("launch")).status_code, 409)
        self.assertEqual((await self.launch(DOMAIN="is4business.bitrix24.ru.evil.test")).status_code, 403)
        self.assertFalse(self.requests)
        await self.launch(); self.requests.clear()
        self.assertEqual((await self.launch("launch", APPLICATION_TOKEN="foreign-application-token")).status_code, 403)
        self.assertFalse(self.requests)

    async def test_portal_proof_cannot_be_forged_by_submitted_member_or_endpoint(self):
        for override in [{"member_id": "foreign"}, {"client_endpoint": "https://evil.test/rest/"},
                         {"client_endpoint": "https://is4business.bitrix24.ru/rest/../"}]:
            self.token_override = override
            self.assertEqual((await self.launch()).status_code, 403)
        self.assertEqual(len(self.requests), 3)

    async def test_wrong_app_inactive_employee_and_non_admin_cannot_install(self):
        self.app_code = "other.app"
        self.assertEqual((await self.launch()).status_code, 403)
        self.app_code = "local.test"; self.active = False
        self.assertEqual((await self.launch()).status_code, 403)
        self.active = True; self.profile_id = "999"
        self.assertEqual((await self.launch()).status_code, 403)
        self.profile_id = None; self.admin = False
        self.assertEqual((await self.launch()).status_code, 403)
        async with self.Session() as db:
            self.assertIsNone((await db.execute(select(BitrixInstallation))).scalar_one_or_none())

    async def test_expired_handoff_is_rejected(self):
        response = await self.launch()
        async with self.Session() as db:
            row = (await db.execute(select(BitrixHandoff))).scalar_one()
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1); await db.commit()
        self.assertEqual((await self.exchange(response)).status_code, 410)

    async def test_pilot_redirect_stays_under_isolated_prefix(self):
        with mock.patch.object(settings, "BITRIX24_PUBLIC_PREFIX", "/bitrix24-pilot"):
            response = await self.launch()
        self.assertEqual(response.status_code, 303)
        self.assertTrue(response.headers["location"].startswith("/bitrix24-pilot/bitrix24.html?"))

    async def test_parallel_exchange_consumes_handoff_exactly_once(self):
        response = await self.launch()
        results = await asyncio.gather(self.exchange(response), self.exchange(response))
        self.assertEqual(sorted(r.status_code for r in results), [200, 410])

    async def test_repeated_invalid_proof_is_limited_before_upstream(self):
        self.token_override = {"member_id": "foreign"}
        for _ in range(6):
            self.assertEqual((await self.launch()).status_code, 403)
        self.assertEqual((await self.launch()).status_code, 429)
        self.assertEqual(len(self.requests), 6)

    async def test_disabled_and_oversized_launches_fail_without_network(self):
        with mock.patch.object(settings, "BITRIX24_CLIENT_SECRET", ""):
            self.assertEqual((await self.launch()).status_code, 404)
        self.assertEqual((await self.launch(extra="x" * 17000)).status_code, 413)
        self.assertFalse(self.requests)

    async def test_upstream_redirect_or_error_never_discloses_tokens(self):
        for response in [httpx.Response(302, headers={"location": "https://evil.test/"}),
                         httpx.Response(200, json={"error": "expired_token", "error_description": "private-refresh"})]:
            with mock.patch.object(b24, "transport", httpx.MockTransport(lambda _: response)):
                result = await self.launch()
                self.assertEqual(result.status_code, 502)
                self.assertNotIn("private-refresh", result.text)

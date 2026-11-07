import asyncio
import json
import secrets
import unittest
from datetime import timedelta
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4
import httpx
from fastapi import FastAPI
from sqlalchemy import select
from app.api import connection_check as api
from app.core import connection_check as checks
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.connection_check import ConnectionCheck
from app.models.device import DeviceSession
from app.models.push import PushSubscription
from tests.stars_base import StarsTestBase

class ConnectionCheckTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.app = FastAPI(); self.app.include_router(api.router)
        async def database():
            async with self.Session() as db: yield db
        self.app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(self.app), base_url="https://quazar-msg.ru")
        self.addAsyncCleanup(self.client.aclose)
        self.user = self.users["alice"]
        self.headers = {"Authorization": "Bearer " + create_access_token(self.user.id)}
        self.delivery = mock.AsyncMock()
        patcher = mock.patch.object(checks, "deliver", self.delivery); patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.object(checks, "AsyncSessionLocal", self.Session); patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.object(api, "push_configured", return_value=True); patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.object(checks, "DELAY_SECONDS", 0); patcher.start(); self.addCleanup(patcher.stop)
        async with self.Session() as db:
            self.sub = PushSubscription(user_id=self.user.id, endpoint="https://fcm.googleapis.com/test/own", p256dh="fake", auth="fake")
            self.other = PushSubscription(user_id=self.users["bob"].id, endpoint="https://fcm.googleapis.com/test/other", p256dh="fake", auth="fake")
            db.add_all([self.sub, self.other]); await db.commit()

    async def start(self, **extra):
        body = {"id": str(uuid4()), "transport": "push", "endpoint": self.sub.endpoint, **extra}
        return await self.client.post("/push/diagnostics", json=body, headers=self.headers)

    async def test_probe_is_scoped_to_one_owned_device_and_contains_no_secrets_in_status(self):
        response = await self.start(); self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        check_id, secret = self.delivery.call_args.args
        async with self.Session() as db:
            row = await db.get(ConnectionCheck, check_id)
            self.assertEqual(row.subscription_id, self.sub.id); self.assertNotEqual(row.secret_hash, secret)
        data = (await self.client.get(f"/push/diagnostics/{check_id}", headers=self.headers)).json()
        self.assertEqual(set(data), {"id", "state", "error_code", "expires_at"})
        foreign = {"Authorization": "Bearer " + create_access_token(self.users["bob"].id)}
        self.assertEqual((await self.client.get(f"/push/diagnostics/{check_id}", headers=foreign)).status_code, 404)

    async def test_cannot_target_other_account_or_an_arbitrary_url(self):
        self.assertEqual((await self.start(endpoint=self.other.endpoint)).status_code, 404)
        async with self.Session() as db:
            self.sub.endpoint = "http://127.0.0.1/private"; await db.merge(self.sub); await db.commit()
        self.assertEqual((await self.start()).status_code, 422)
        self.delivery.assert_not_awaited()

    async def test_persistent_limit_allows_only_three_checks_per_minute(self):
        results = await asyncio.gather(*(self.start(transport="desktop", endpoint=None) for _ in range(4)))
        self.assertEqual(sorted(result.status_code for result in results), [200, 200, 200, 429])

    async def test_receipt_requires_secret_and_cannot_confirm_an_expired_check(self):
        response = await self.start(); check_id, secret = self.delivery.call_args.args
        path = f"/push/diagnostics/{check_id}/receipt"
        self.assertEqual((await self.client.post(path, json={"secret": secrets.token_urlsafe(32)})).status_code, 404)
        self.assertEqual((await self.client.post(path, json={"secret": secret})).status_code, 204)
        self.assertEqual((await self.client.post(path, json={"secret": secret})).status_code, 204)
        self.assertEqual((await self.client.get(f"/push/diagnostics/{check_id}", headers=self.headers)).json()["state"], "displayed")
        async with self.Session() as db:
            (await db.get(ConnectionCheck, check_id)).expires_at = checks.now() - timedelta(seconds=1); await db.commit()
        self.assertEqual((await self.client.post(path, json={"secret": secret})).status_code, 410)

    async def test_desktop_event_reaches_only_the_current_session_and_receipt_wins_the_race(self):
        await self.start(transport="desktop", endpoint=None); check_id, secret = self.delivery.call_args.args
        async with self.Session() as db: row = await db.get(ConnectionCheck, check_id); sid = row.session_id
        async def receive(text):
            event = json.loads(text); self.assertEqual(event["test_id"], check_id)
            self.assertEqual(event["receipt_secret"], secret)
            response = await self.client.post(f"/push/diagnostics/{check_id}/receipt", json={"secret": secret})
            self.assertEqual(response.status_code, 204)
        own = SimpleNamespace(_quazar_session_id=sid, send_text=mock.AsyncMock(side_effect=receive))
        other = SimpleNamespace(_quazar_session_id="other-device", send_text=mock.AsyncMock())
        with mock.patch.dict(checks.manager.user_connections, {self.user.id: [own, other]}, clear=True):
            await self.run_delivery(check_id, secret)
        own.send_text.assert_awaited_once(); other.send_text.assert_not_awaited()
        async with self.Session() as db: self.assertEqual((await db.get(ConnectionCheck, check_id)).state, "displayed")

    async def run_delivery(self, check_id, secret):
        # The real implementation is loaded before patching the background-task entrypoint.
        await REAL_DELIVER(check_id, secret)

    async def test_push_transport_receives_only_the_selected_subscription(self):
        await self.start(); check_id, secret = self.delivery.call_args.args
        probe = mock.AsyncMock(return_value=None)
        with mock.patch.object(checks, "send_probe", probe): await self.run_delivery(check_id, secret)
        self.assertEqual(probe.call_args.args[0].id, self.sub.id)
        payload = probe.call_args.args[1]
        self.assertEqual(payload["type"], "connection_test"); self.assertEqual(payload["receipt_secret"], secret)
        async with self.Session() as db: self.assertEqual((await db.get(ConnectionCheck, check_id)).state, "sent")

    async def test_expired_subscription_is_removed_without_touching_other_devices(self):
        await self.start(); check_id, secret = self.delivery.call_args.args
        with mock.patch.object(checks, "send_probe", mock.AsyncMock(return_value="subscription_expired")):
            await self.run_delivery(check_id, secret)
        async with self.Session() as db:
            self.assertIsNone(await db.get(PushSubscription, self.sub.id)); self.assertIsNotNone(await db.get(PushSubscription, self.other.id))
            row = await db.get(ConnectionCheck, check_id)
            self.assertEqual((row.state, row.error_code), ("failed", "subscription_expired"))

    async def test_unsupported_endpoints_are_rejected_before_network_access(self):
        for url in ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://fcm.googleapis.com.evil.test/x", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x"]:
            self.assertFalse(checks.allowed_endpoint(url))
        for url in ["https://fcm.googleapis.com/x", "https://updates.push.services.mozilla.com/x", "https://web.push.apple.com/x", "https://wns2-xx.notify.windows.com/x"]:
            self.assertTrue(checks.allowed_endpoint(url))

REAL_DELIVER = checks.deliver

class ProbeTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_probe_disallows_redirects_and_uses_a_fresh_provider_request(self):
        sub = SimpleNamespace(endpoint="https://fcm.googleapis.com/test/one", p256dh="public", auth="auth")
        seen = []
        def sdk(**kwargs):
            seen.append(kwargs)
            self.assertFalse(kwargs["requests_session"].trust_env)
            return kwargs["requests_session"].post(sub.endpoint)
        with mock.patch.object(settings, "VAPID_PUBLIC_KEY", "fake-public"), mock.patch.object(settings, "VAPID_PRIVATE_KEY", "fake-private"), \
             mock.patch.object(checks, "_assert_public", mock.AsyncMock()), \
             mock.patch("pywebpush.webpush", side_effect=sdk), \
             mock.patch("requests.Session.post", return_value=SimpleNamespace(status_code=201)) as request:
            self.assertIsNone(await checks.send_probe(sub, {"type": "connection_test"}))
        self.assertFalse(request.call_args.kwargs["allow_redirects"])
        self.assertEqual(seen[0]["ttl"], 60); self.assertEqual(seen[0]["timeout"], 10)

"""Квазар как провайдер входа для Padma: /oauth/client, /oauth/authorize, /oauth/token, /oauth/userinfo."""

import base64
import hashlib
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import FastAPI
from sqlalchemy import update

from app.api import oauth_provider as provider
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.oauth_provider import OAuthAccessToken, OAuthCode
from app.models.user import User
from tests.stars_base import StarsTestBase

REDIRECT = "https://www.padma.ru/api/auth/quazar/callback"
LOCAL = "http://localhost:5173/api/auth/quazar/callback"
SECRET = "s3cret-" + "x" * 40
VERIFIER = "v" * 43 + "-._~abc"


def challenge(verifier: str = VERIFIER) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


class OAuthProviderTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        patcher = mock.patch.multiple(settings, PADMA_OAUTH_CLIENT_ID="padma", PADMA_OAUTH_CLIENT_SECRET=SECRET,
                                      PADMA_OAUTH_REDIRECT_URIS=f"{REDIRECT}, {LOCAL}")
        patcher.start(); self.addCleanup(patcher.stop)
        provider._token_calls.clear()
        self.addCleanup(provider._token_calls.clear)
        app = FastAPI()
        app.include_router(provider.router)

        async def database():
            async with self.Session() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)
        await self.set_user("alice", phone_verified_at=datetime.now(timezone.utc), first_name="Анна", last_name=None)

    async def set_user(self, who: str, **values):
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.users[who].id).values(**values))
            await db.commit()

    def bearer(self, who="alice"):
        return {"Authorization": "Bearer " + create_access_token(self.users[who].id)}

    async def authorize(self, who="alice", **overrides):
        body = {"client_id": "padma", "redirect_uri": REDIRECT, "state": "st-1", "code_challenge": challenge(),
                "code_challenge_method": "S256", **overrides}
        return await self.client.post("/oauth/authorize", json=body, headers=self.bearer(who) if who else {})

    async def code(self, who="alice", **overrides) -> str:
        response = await self.authorize(who, **overrides)
        self.assertEqual(response.status_code, 200, response.text)
        query = parse_qs(urlsplit(response.json()["redirect_to"]).query)
        return query["code"][0]

    async def exchange(self, code: str, **overrides):
        form = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
                "code_verifier": VERIFIER, "client_id": "padma", "client_secret": SECRET, **overrides}
        return await self.client.post("/oauth/token", data=form)

    async def userinfo(self, token: str):
        return await self.client.get("/oauth/userinfo", headers={"Authorization": f"Bearer {token}"})

    # --- клиент и адрес возврата ---

    async def test_everything_is_404_until_configured(self):
        with mock.patch.object(settings, "PADMA_OAUTH_CLIENT_SECRET", ""):
            for response in (
                await self.client.get("/oauth/client", params={"client_id": "padma", "redirect_uri": REDIRECT}),
                await self.authorize(),
                await self.exchange("x"),
                await self.userinfo("x"),
            ):
                self.assertEqual(response.status_code, 404)

    async def test_unknown_client_or_redirect_uri_is_rejected(self):
        ok = await self.client.get("/oauth/client", params={"client_id": "padma", "redirect_uri": LOCAL})
        self.assertEqual(ok.json(), {"name": "Padma"})
        for client_id, uri in (("other", REDIRECT), ("padma", "https://evil.example/cb"), ("padma", REDIRECT + "/")):
            response = await self.client.get("/oauth/client", params={"client_id": client_id, "redirect_uri": uri})
            self.assertEqual(response.status_code, 400)
            self.assertEqual((await self.authorize(client_id=client_id, redirect_uri=uri)).status_code, 400)

    # --- выдача кода ---

    async def test_code_needs_a_session_a_verified_phone_and_pkce(self):
        self.assertIn((await self.authorize(who=None)).status_code, (401, 403))
        unverified = await self.authorize(who="bob")
        self.assertEqual((unverified.status_code, unverified.json()["detail"]), (403, "phone_unverified"))
        self.assertEqual((await self.authorize(code_challenge_method="plain")).status_code, 400)
        self.assertEqual((await self.authorize(code_challenge="short")).status_code, 400)
        await self.set_user("alice", is_active=False)
        self.assertEqual((await self.authorize()).status_code, 403)

    async def test_redirect_carries_code_and_state(self):
        response = await self.authorize(state="a b&c")
        target = urlsplit(response.json()["redirect_to"])
        self.assertEqual(f"{target.scheme}://{target.netloc}{target.path}", REDIRECT)
        query = parse_qs(target.query)
        self.assertEqual(query["state"], ["a b&c"])
        self.assertGreaterEqual(len(query["code"][0]), 43)

    # --- обмен кода ---

    async def test_full_flow_returns_the_profile(self):
        token = await self.exchange(await self.code())
        self.assertEqual(token.status_code, 200, token.text)
        self.assertEqual(token.headers["cache-control"], "no-store")
        body = token.json()
        self.assertEqual((body["token_type"], body["expires_in"]), ("Bearer", 300))
        profile = await self.userinfo(body["access_token"])
        self.assertEqual(profile.status_code, 200, profile.text)
        self.assertEqual(profile.json(), {
            "sub": self.users["alice"].id, "phone_number": "+79000000003", "phone_number_verified": True,
            "given_name": "Анна", "family_name": None, "preferred_username": "alice",
        })

    async def test_wrong_secret_is_invalid_client(self):
        code = await self.code()
        for overrides in ({"client_secret": SECRET + "x"}, {"client_secret": ""}, {"client_id": "other"}):
            response = await self.exchange(code, **overrides)
            self.assertEqual((response.status_code, response.json()), (401, {"error": "invalid_client"}))
        # Код не сгорел от попыток с чужим секретом.
        self.assertEqual((await self.exchange(code)).status_code, 200)

    async def test_wrong_verifier_or_redirect_burns_the_code(self):
        for overrides in ({"code_verifier": "w" * 43}, {"redirect_uri": LOCAL}):
            code = await self.code()
            bad = await self.exchange(code, **overrides)
            self.assertEqual((bad.status_code, bad.json()), (400, {"error": "invalid_grant"}))
            self.assertEqual((await self.exchange(code)).json(), {"error": "invalid_grant"})

    async def test_expired_and_unknown_codes(self):
        code = await self.code()
        async with self.Session() as db:
            await db.execute(update(OAuthCode).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
            await db.commit()
        self.assertEqual((await self.exchange(code)).json(), {"error": "invalid_grant"})
        self.assertEqual((await self.exchange("nope")).json(), {"error": "invalid_grant"})
        self.assertEqual((await self.exchange(await self.code(), grant_type="password")).json(),
                         {"error": "unsupported_grant_type"})

    async def test_reused_code_revokes_the_token(self):
        code = await self.code()
        token = (await self.exchange(code)).json()["access_token"]
        self.assertEqual((await self.userinfo(token)).status_code, 200)
        self.assertEqual((await self.exchange(code)).json(), {"error": "invalid_grant"})
        self.assertEqual((await self.userinfo(token)).status_code, 401)

    async def test_token_endpoint_wants_a_form_and_limits_rate(self):
        json_body = await self.client.post("/oauth/token", json={"grant_type": "authorization_code"})
        self.assertEqual(json_body.json(), {"error": "invalid_request"})
        with mock.patch.object(provider, "TOKEN_RATE", 2):
            provider._token_calls.clear()
            await self.exchange("a"); await self.exchange("b")
            limited = await self.exchange("c")
            self.assertEqual((limited.status_code, limited.json()), (429, {"error": "slow_down"}))

    # --- userinfo ---

    async def test_userinfo_rejects_foreign_expired_and_blocked(self):
        self.assertEqual((await self.userinfo("not-a-token")).status_code, 401)
        self.assertEqual((await self.client.get("/oauth/userinfo")).status_code, 401)
        # Сессионный токен Квазара — не токен доступа клиента.
        session = create_access_token(self.users["alice"].id)
        self.assertEqual((await self.userinfo(session)).status_code, 401)

        token = (await self.exchange(await self.code())).json()["access_token"]
        async with self.Session() as db:
            await db.execute(update(OAuthAccessToken).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
            await db.commit()
        self.assertEqual((await self.userinfo(token)).status_code, 401)

        token = (await self.exchange(await self.code())).json()["access_token"]
        await self.set_user("alice", blocked_at=datetime.now(timezone.utc))
        response = await self.userinfo(token)
        self.assertEqual((response.status_code, response.json()), (401, {"error": "invalid_token"}))

    async def test_blocked_or_unverified_user_cannot_exchange_a_code(self):
        code = await self.code()
        await self.set_user("alice", phone_verified_at=None)
        self.assertEqual((await self.exchange(code)).json(), {"error": "invalid_grant"})

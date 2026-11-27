"""Квазар как провайдер входа для Padma: /oauth/client, /oauth/authorize, /oauth/token, /oauth/userinfo."""

import base64
import hashlib
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import FastAPI
from sqlalchemy import update

import secrets
import unittest

from sqlalchemy import select

from app.api import oauth_provider as provider
from app.core import phone_verification as verification
from app.core.auto_username import auto_username, compose, latin_part
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.oauth_provider import OAuthAccessToken, OAuthCode
from app.models.phone_verification import PhoneVerification
from app.models.user import User
from tests.stars_base import StarsTestBase

REDIRECT = "https://www.padma.ru/api/auth/quazar/callback"
LOCAL = "http://localhost:5173/api/auth/quazar/callback"
SECRET = "s3cret-" + "x" * 40
VERIFIER = "v" * 43 + "-._~abc"


def challenge(verifier: str = VERIFIER) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


class OAuthBase(StarsTestBase):
    """Клиент Padma в настройках, HTTP-клиент к роутеру и помощники — без тестов."""

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
        await self.set_user("alice", phone_verified_at=datetime.now(timezone.utc), first_name="Анна", last_name="Иванова")

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



class OAuthProviderTest(OAuthBase):
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
            "given_name": "Анна", "family_name": "Иванова", "preferred_username": "alice",
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


class OAuthSignupTest(OAuthBase):
    """Этап 3.1: упрощённая регистрация «для Padma» и обязательные имя и фамилия."""

    async def proof(self, phone="+79160001122", token=None):
        token = token or secrets.token_urlsafe(32)
        now = verification.now()
        async with self.Session() as db:
            db.add(PhoneVerification(token_hash=verification.digest(token), phone=phone, purpose="register", ip_hash="ip",
                                     campaign_id="1", state="verified", verified_at=now, created_at=now,
                                     expires_at=now + timedelta(minutes=5)))
            await db.commit()
        return token

    async def register(self, **overrides):
        body = {"client_id": "padma", "redirect_uri": REDIRECT, "phone": "+7 916 000-11-22",
                "phone_verification_token": overrides.pop("token", None) or await self.proof(),
                "last_name": "Иванов", "first_name": "Пётр", **overrides}
        return await self.client.post("/oauth/register", json=body)

    async def created(self, username):
        async with self.Session() as db:
            return (await db.execute(select(User).where(User.username == username))).scalar_one()

    async def test_signup_creates_a_hidden_passwordless_account_with_an_auto_nickname(self):
        response = await self.register()
        self.assertEqual(response.status_code, 201, response.text)
        user = await self.created("ivanov_petr")
        self.assertEqual((user.phone, user.first_name, user.last_name), ("+79160001122", "Пётр", "Иванов"))
        self.assertIs(user.phone_discoverable, False)
        self.assertIsNone(user.password_hash)
        self.assertIsNotNone(user.phone_verified_at)
        self.assertIsNone(user.email)
        # Код всё равно выдаётся только по «Продолжить» — уже с новой сессией.
        headers = {"Authorization": "Bearer " + response.json()["access_token"]}
        body = {"client_id": "padma", "redirect_uri": REDIRECT, "state": "s", "code_challenge": challenge(),
                "code_challenge_method": "S256"}
        authorized = await self.client.post("/oauth/authorize", json=body, headers=headers)
        code = parse_qs(urlsplit(authorized.json()["redirect_to"]).query)["code"][0]
        token = (await self.exchange(code)).json()["access_token"]
        info = (await self.userinfo(token)).json()
        self.assertEqual((info["given_name"], info["family_name"], info["preferred_username"]), ("Пётр", "Иванов", "ivanov_petr"))
        self.assertEqual((await self.register(phone="+79160001122", token=await self.proof(token="u" * 43))).status_code, 400)

    async def test_signup_needs_both_names_a_proof_and_a_known_client(self):
        for overrides in ({"last_name": " "}, {"first_name": ""}, {"first_name": "123"}):
            self.assertEqual((await self.register(**overrides)).status_code, 422)
        self.assertEqual((await self.register(token="z" * 43)).status_code, 400)
        self.assertEqual((await self.register(redirect_uri="https://evil.example/cb")).status_code, 400)
        with mock.patch.object(settings, "PADMA_OAUTH_CLIENT_SECRET", ""):
            self.assertEqual((await self.register()).status_code, 404)
        async with self.Session() as db:
            self.assertEqual((await db.execute(select(User).where(User.phone == "+79160001122"))).first(), None)

    async def test_nickname_duplicates_get_numbers_case_insensitively(self):
        await self.set_user("bob", username="Ivanov_Petr")
        await self.set_user("carol", username="ivanov_petr2")
        self.assertEqual((await self.register()).status_code, 201)
        await self.created("ivanov_petr3")

    async def test_failed_signup_does_not_burn_the_phone_proof(self):
        token = await self.proof()
        self.assertEqual((await self.register(token=token, last_name="")).status_code, 422)
        self.assertEqual((await self.register(token=token)).status_code, 201)

    async def test_code_and_profile_need_first_and_last_name(self):
        await self.set_user("alice", last_name=None)
        response = await self.authorize()
        self.assertEqual((response.status_code, response.json()["detail"]), (403, "name_required"))
        await self.set_user("alice", last_name="Иванова")
        token = (await self.exchange(await self.code())).json()["access_token"]
        await self.set_user("alice", first_name="  ")
        self.assertEqual((await self.userinfo(token)).status_code, 401)


class AutoUsernameTest(unittest.TestCase):
    def test_transliteration_follows_the_table(self):
        self.assertEqual(latin_part("Пётр"), "petr")
        self.assertEqual(latin_part("Щукина-Чернышёва"), "shchukinachernysheva")
        self.assertEqual(latin_part("Хрущёв"), "khrushchev")
        self.assertEqual(latin_part("Цой Юлия"), "tsoyyuliya")
        self.assertEqual(latin_part("Подъячев Ильич"), "podyachevilich")
        self.assertEqual(latin_part("O'Brien"), "obrien")
        self.assertEqual(latin_part("José"), "jose")
        self.assertEqual(latin_part("李"), "")

    def test_long_last_names_are_cut_to_fit_the_first_name_and_suffix(self):
        long = "konstantinopolskiy" * 2
        for suffix in ("", "2", "123"):
            nick = compose(long, "aleksandr", suffix)
            self.assertEqual(len(nick), 32)
            self.assertTrue(nick.endswith("_aleksandr" + suffix))
        self.assertEqual(compose("ivanov", "petr"), "ivanov_petr")
        self.assertEqual(compose("", "petr"), "petr")


class AutoUsernameFallbackTest(StarsTestBase):
    async def test_empty_or_forbidden_results_fall_back_to_user_digits(self):
        async with self.Session() as db:
            for last, first in (("李", "王"), ("Ли", ""), ("Quazar", "")):
                nick = await auto_username(db, last, first)
                self.assertRegex(nick, r"^user_\d{5}$")
            self.assertEqual(await auto_username(db, "Иванов", "Пётр"), "ivanov_petr")

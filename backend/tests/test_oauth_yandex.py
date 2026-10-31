"""Вход через Яндекс ID: регистрация новичка, вход, привязка, безопасность одноразовых кодов.

Яндекс подменён (httpx.MockTransport). Нужна PostgreSQL (TEST_DATABASE_URL); без базы
тесты пропускаются.
"""

import json
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException
from sqlalchemy import select, update

from app.api import auth as auth_api
from app.api import oauth
from app.core import yandex
from app.core.config import settings
from app.core.security import decode_token, hash_password
from app.models.user import OAuthFlow, User, UserIdentity
from app.schemas.user import UserLogin
from tests.stars_base import StarsTestBase

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


class YandexOAuthTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for name, value in (("YANDEX_CLIENT_ID", "cid"), ("YANDEX_CLIENT_SECRET", "secret"),
                            ("PUBLIC_URL", "https://quazar.test"), ("MEDIA_ROOT", self.media_dir())):
            patcher = mock.patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.profile = {
            "id": "1130000012345678", "login": "anna.petrova", "default_email": "anna@yandex.ru",
            "first_name": "Анна", "last_name": "Петрова", "default_phone": {"number": "+79161234567"},
            "default_avatar_id": "123/abc-1", "is_avatar_empty": False,
        }
        self.token_requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "oauth.yandex.ru":
                self.token_requests.append(parse_qs(request.content.decode()))
                if parse_qs(request.content.decode()).get("code") == ["bad"]:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": "ya-token"})
            if request.url.host == "login.yandex.ru":
                assert request.headers["authorization"] == "OAuth ya-token"
                return httpx.Response(200, json=self.profile)
            if request.url.host == "avatars.yandex.net":
                return httpx.Response(200, content=PNG)
            return httpx.Response(404)

        patcher = mock.patch.object(yandex, "transport", httpx.MockTransport(handler))
        patcher.start()
        self.addCleanup(patcher.stop)

    def media_dir(self) -> str:
        import tempfile

        return tempfile.mkdtemp()

    async def db_call(self, fn, *args, **kwargs):
        async with self.Session() as db:
            return await fn(*args, db=db, **kwargs)

    async def start(self, client="web") -> str:
        resp = await self.db_call(oauth.yandex_start, client=client)
        url = urlsplit(resp.headers["location"])
        params = parse_qs(url.query)
        self.assertEqual(url.netloc, "oauth.yandex.ru")
        self.assertEqual(params["redirect_uri"], ["https://quazar.test/api/auth/yandex/callback"])
        self.assertEqual(params["code_challenge_method"], ["S256"])
        return params["state"][0]

    async def callback(self, state: str, code="good", **kw) -> dict[str, str]:
        resp = await self.db_call(oauth.yandex_callback, state=state, code=code, error=kw.get("error", ""))
        location = resp.headers["location"]
        base, _, fragment = location.partition("#")
        return {"base": base, **{k: v[0] for k, v in parse_qs(fragment).items()}}

    async def test_new_user_registers_without_password(self):
        back = await self.callback(await self.start())
        self.assertEqual(back["base"], "https://quazar.test/auth/yandex")
        # PKCE: Яндексу ушёл verifier, а не секрет в адресе.
        self.assertIn("code_verifier", self.token_requests[0])
        out = await self.db_call(oauth.yandex_exchange, oauth.ExchangeBody(code=back["code"]))
        self.assertEqual(out.status, "register")
        self.assertEqual(
            (out.profile.username, out.profile.phone, out.profile.email, out.profile.first_name),
            ("anna_petrova", "+79161234567", "anna@yandex.ru", "Анна"),
        )
        token = await self.db_call(oauth.yandex_complete, oauth.CompleteBody(
            code=back["code"], username="anna_p", phone="+7 916 123-45-67", phone_discoverable=False,
            first_name="Анна", last_name="Петрова"))
        uid = decode_token(token.access_token)
        async with self.Session() as db:
            user = await db.get(User, uid)
            self.assertIsNone(user.password_hash)
            self.assertEqual((user.username, user.email), ("anna_p", "anna@yandex.ru"))
            self.assertTrue(user.avatar_url)
            identity = (await db.execute(select(UserIdentity))).scalar_one()
            self.assertEqual((identity.user_id, identity.subject), (uid, "1130000012345678"))
        # Пароля нет — по паролю не войти (даже пустому).
        with self.assertRaises(HTTPException):
            await self.db_call(auth_api.login, UserLogin(phone="+79161234567", password="whatever1"))
        # Код одноразовый.
        with self.assertRaises(HTTPException) as ctx:
            await self.db_call(oauth.yandex_exchange, oauth.ExchangeBody(code=back["code"]))
        self.assertEqual(ctx.exception.status_code, 410)

        # Второй вход тем же Яндексом — сразу сессия того же аккаунта.
        again = await self.callback(await self.start())
        out = await self.db_call(oauth.yandex_exchange, oauth.ExchangeBody(code=again["code"]))
        self.assertEqual((out.status, decode_token(out.access_token)), ("login", uid))

    async def test_no_auto_merge_by_phone_or_email(self):
        # Номер и почта из Яндекса уже у alice — данные не подставляем и аккаунт не склеиваем.
        async with self.Session() as db:
            await db.execute(update(User).where(User.username == "alice").values(phone="+79161234567", email="anna@yandex.ru"))
            await db.commit()
        back = await self.callback(await self.start())
        out = await self.db_call(oauth.yandex_exchange, oauth.ExchangeBody(code=back["code"]))
        self.assertEqual(out.status, "register")
        self.assertIsNone(out.profile.phone)
        self.assertIsNone(out.profile.email)
        await self.expect_status(400, oauth.yandex_complete, oauth.CompleteBody(
            code=back["code"], username="anna_x", phone="+79161234567", phone_discoverable=True))

    async def test_link_to_existing_account_and_unlink_rules(self):
        alice = self.users["alice"]
        link = await self.call(oauth.yandex_link_start, user="alice")
        state = parse_qs(urlsplit(link.url).query)["state"][0]
        back = await self.callback(state)
        self.assertEqual(back["linked"], "ok")
        info = await self.call(oauth.my_sign_in, user="alice")
        self.assertEqual([i.email for i in info.identities], ["anna@yandex.ru"])
        # Тот же Яндекс к другому аккаунту — нельзя.
        link = await self.call(oauth.yandex_link_start, user="bob")
        back = await self.callback(parse_qs(urlsplit(link.url).query)["state"][0])
        self.assertEqual(back["linked"], "taken")
        # Вход Яндексом теперь открывает alice.
        login = await self.callback(await self.start())
        out = await self.db_call(oauth.yandex_exchange, oauth.ExchangeBody(code=login["code"]))
        self.assertEqual(decode_token(out.access_token), alice.id)

        # У alice нет пароля (как будто зарегистрирована через Яндекс) — отвязать нельзя.
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == alice.id).values(password_hash=None))
            await db.commit()
        await self.expect_error(409, oauth.unlink_identity, "yandex", user="alice")
        await self.call(oauth.set_password, oauth.PasswordBody(new_password="newsecret1"), user="alice")
        await self.call(oauth.unlink_identity, "yandex", user="alice")
        self.assertEqual((await self.call(oauth.my_sign_in, user="alice")).identities, [])

    async def test_change_password_needs_current(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.username == "bob").values(password_hash=hash_password("oldsecret1")))
            await db.commit()
        await self.expect_error(401, oauth.set_password, oauth.PasswordBody(new_password="newsecret1"), user="bob")
        await self.call(oauth.set_password, oauth.PasswordBody(current_password="oldsecret1", new_password="newsecret1"), user="bob")
        await self.db_call(auth_api.login, UserLogin(phone=self.users["bob"].phone, password="newsecret1"))

    async def test_bad_states_and_errors(self):
        # Неизвестный state, отказ пользователя, ошибка Яндекса, просроченный и повторный state.
        self.assertEqual((await self.callback("nope"))["error"], "expired")
        self.assertEqual((await self.callback(await self.start(), error="access_denied"))["error"], "denied")
        self.assertEqual((await self.callback(await self.start(), code="bad"))["error"], "yandex")
        state = await self.start()
        async with self.Session() as db:
            await db.execute(update(OAuthFlow).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
            await db.commit()
        self.assertEqual((await self.callback(state))["error"], "expired")
        state = await self.start()
        await self.callback(state)
        self.assertEqual((await self.callback(state))["error"], "expired")
        # Мобильный клиент возвращается по своей ссылке.
        back = await self.callback(await self.start(client="mobile"))
        self.assertEqual(back["base"], "quazar://auth/yandex")

    async def test_blocked_account_cannot_sign_in(self):
        async with self.Session() as db:
            db.add(UserIdentity(user_id=self.users["carol"].id, provider="yandex", subject="1130000012345678"))
            await db.execute(update(User).where(User.username == "carol").values(blocked_at=datetime.now(timezone.utc)))
            await db.commit()
        back = await self.callback(await self.start())
        await self.expect_status(403, oauth.yandex_exchange, oauth.ExchangeBody(code=back["code"]))

    async def test_disabled_without_keys(self):
        with mock.patch.object(settings, "YANDEX_CLIENT_ID", ""):
            self.assertFalse((await oauth.providers()).yandex)
            with self.assertRaises(HTTPException) as ctx:
                await self.db_call(oauth.yandex_start, client="web")
            self.assertEqual(ctx.exception.status_code, 404)

    async def expect_status(self, code: int, fn, *args):
        with self.assertRaises(HTTPException) as ctx:
            await self.db_call(fn, *args)
        self.assertEqual(ctx.exception.status_code, code, json.dumps(str(ctx.exception.detail), ensure_ascii=False))

import asyncio
import json
from datetime import datetime, timedelta, timezone
from unittest import mock

import httpx
from fastapi import FastAPI
from jose import jwt
from sqlalchemy import func, select

from app.api import auth, oauth, password_recovery as recovery, support as support_api, users
from app.core import support, news
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token, hash_password, token_is_current, verify_password
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.support import SupportTicket
from app.models.user import User
from tests.stars_base import StarsTestBase


class PasswordRecoveryTest(StarsTestBase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 1
        await super().asyncSetUp()
        async with self.Session() as db:
            self.alice = await db.get(User, self.users["alice"].id)
            self.alice.password_hash = hash_password("old-password-1")
            self.alice.public_key = "public-key-unchanged"
            self.alice.key_backup = "encrypted-backup-unchanged"
            self.owner = await db.get(User, self.users["owner"].id)
            self.owner.is_superuser = True
            await db.commit()
            await support.bot_user(db)
        self.alice_token = create_access_token(self.alice.id)
        self.owner_token = create_access_token(self.owner.id)
        self.app = FastAPI()
        for router in (auth.router, recovery.router, recovery.admin_router, support_api.admin_router, oauth.me_router, users.router):
            self.app.include_router(router)
        async def database():
            async with self.Session() as db:
                yield db
        self.app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, raise_app_exceptions=False), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)
        patcher = mock.patch.object(recovery, "MIN_RESPONSE_SECONDS", 0)
        patcher.start(); self.addCleanup(patcher.stop)
        recovery._requests.clear()

    def bearer(self, token):
        return {"Authorization": "Bearer " + token}

    async def request_recovery(self, login="@Alice"):
        return await self.client.post("/auth/forgot-password", json={"login": login})

    async def tickets(self):
        async with self.Session() as db:
            return list((await db.execute(select(SupportTicket).where(SupportTicket.recovery_login.is_not(None)))).scalars())

    async def assign(self, ticket_id, password="new-password-2", token=None):
        return await self.client.post(f"/admin/tickets/{ticket_id}/password", headers=self.bearer(token or self.owner_token),
                                      json={"new_password": password, "confirm_password": password})

    async def test_anonymous_request_creates_a_bug_with_the_claimed_login_and_system_author(self):
        response = await self.request_recovery()
        self.assertEqual(response.status_code, 202)
        (ticket,) = await self.tickets()
        self.assertEqual(ticket.kind, "bug")
        self.assertEqual(ticket.recovery_login, "@Alice")
        self.assertIn("@Alice", ticket.text)
        self.assertIn("без авторизации", ticket.text)
        self.assertEqual(ticket.user_id, self.alice.id)
        async with self.Session() as db:
            card = await db.get(Message, ticket.message_id)
            self.assertNotEqual(card.sender_id, self.alice.id)
        result = await self.client.get("/admin/tickets", headers=self.bearer(self.owner_token))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()[0]["recovery_login"], "@Alice")

    async def test_unknown_login_does_not_expose_account_existence(self):
        known = await self.request_recovery()
        unknown = await self.request_recovery("nobody-here")
        self.assertEqual(known.status_code, unknown.status_code)
        self.assertEqual(known.json(), unknown.json())
        self.assertEqual(len(await self.tickets()), 1)

    async def test_phone_and_nickname_requests_are_deduplicated_even_concurrently(self):
        results = await asyncio.gather(self.request_recovery("alice"), self.request_recovery(self.alice.phone))
        self.assertEqual([result.status_code for result in results], [202, 202])
        self.assertEqual(len(await self.tickets()), 1)
        async with self.Session() as db:
            chats = (await db.execute(select(func.count()).select_from(Chat).join(ChatMember).where(
                Chat.type == "support", ChatMember.user_id == self.alice.id))).scalar_one()
            self.assertEqual(chats, 1)

    async def test_only_black_hole_admins_can_assign_a_password(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        normal = await self.assign(ticket.id, token=self.alice_token)
        anonymous = await self.client.post(f"/admin/tickets/{ticket.id}/password",
            json={"new_password": "new-password-2", "confirm_password": "new-password-2"})
        self.assertEqual(normal.status_code, 404)
        self.assertEqual(anonymous.status_code, 404)

    async def test_assignment_updates_password_closes_request_and_never_puts_the_secret_in_ticket(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        password = "new-password-2"
        result = await self.assign(ticket.id, password)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIsNone(result.json()["access_token"])
        detail = result.json()["ticket"]
        self.assertEqual(detail["status"], "done")
        self.assertIsNotNone(detail["password_reset_at"])
        self.assertNotIn(password, json.dumps(detail))
        async with self.Session() as db:
            user = await db.get(User, self.alice.id)
            saved = await db.get(SupportTicket, ticket.id)
            self.assertTrue(verify_password(password, user.password_hash))
            self.assertFalse(verify_password("old-password-1", user.password_hash))
            self.assertEqual(user.public_key, "public-key-unchanged")
            self.assertEqual(user.key_backup, "encrypted-backup-unchanged")
            self.assertEqual(saved.password_reset_by_id, self.owner.id)
        self.assertEqual((await self.client.get("/users/me", headers=self.bearer(self.alice_token))).status_code, 401)
        logged_in = await self.client.post("/auth/login", json={"phone": self.alice.phone, "password": password})
        self.assertEqual(logged_in.status_code, 200)
        self.assertEqual((await self.client.get("/users/me", headers=self.bearer(logged_in.json()["access_token"]))).status_code, 200)

    async def test_recovery_confirmation_uses_support_bot_when_news_bot_was_created_first(self):
        async with self.Session() as db:
            await db.delete(await support.bot_user(db))
            await db.commit()
            news_bot = await news.bot_user(db)
            support_bot = await support.bot_user(db)
            self.assertNotEqual(news_bot.id, support_bot.id)
            support_id = support_bot.id
        await self.request_recovery()
        (ticket,) = await self.tickets()
        result = await self.assign(ticket.id)
        self.assertEqual(result.status_code, 200, result.text)
        async with self.Session() as db:
            confirmation = (await db.execute(select(Message).where(
                Message.chat_id == ticket.chat_id,
                Message.payload.startswith("Администратор назначил новый пароль"),
            ))).scalar_one()
            self.assertEqual(confirmation.sender_id, support_id)

    async def test_finished_request_cannot_reset_password_a_second_time(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        self.assertEqual((await self.assign(ticket.id)).status_code, 200)
        self.assertEqual((await self.assign(ticket.id, "yet-another-password")).status_code, 409)
        login = await self.client.post("/auth/login", json={"phone": self.alice.phone, "password": "new-password-2"})
        self.assertEqual(login.status_code, 200)

    async def test_ordinary_error_report_does_not_allow_password_assignment(self):
        async with self.Session() as db:
            user = await db.get(User, self.alice.id)
            ticket = await support.create_ticket(db, user, "bug", "Обычная ошибка", [])
        result = await self.assign(ticket.id)
        self.assertEqual(result.status_code, 404)

    async def test_assignment_closes_connected_websockets(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        ws = mock.Mock(close=mock.AsyncMock())
        from app.core.passwords import manager
        with mock.patch.object(manager, "user_connections", {self.alice.id: [ws]}):
            self.assertEqual((await self.assign(ticket.id)).status_code, 200)
        ws.close.assert_awaited_once_with(code=4001)

    async def test_revoked_token_cannot_reconnect_to_websocket(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        await self.assign(ticket.id)
        from app.ws import router as ws_router
        ws = mock.Mock(close=mock.AsyncMock())
        with mock.patch.object(ws_router, "AsyncSessionLocal", self.Session), \
                mock.patch.object(ws_router.manager, "connect", new_callable=mock.AsyncMock) as connect:
            await ws_router.websocket_endpoint(ws, self.alice_token)
        ws.close.assert_awaited_once_with(code=4001)
        connect.assert_not_awaited()

    async def test_old_password_and_new_password_confirmation_are_checked(self):
        endpoint = "/users/me/password"
        body = {"current_password": "wrong-password", "new_password": "new-password-2", "confirm_password": "new-password-2"}
        bad_old = await self.client.put(endpoint, headers=self.bearer(self.alice_token), json=body)
        self.assertEqual(bad_old.status_code, 400)
        body.update(current_password="old-password-1", confirm_password="different-password")
        self.assertEqual((await self.client.put(endpoint, headers=self.bearer(self.alice_token), json=body)).status_code, 422)
        self.assertEqual((await self.client.get("/users/me", headers=self.bearer(self.alice_token))).status_code, 200)

    async def test_own_change_returns_a_fresh_session_and_resolves_pending_recovery(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        response = await self.client.put("/users/me/password", headers=self.bearer(self.alice_token),
            json={"current_password": "old-password-1", "new_password": "new-password-2", "confirm_password": "new-password-2"})
        self.assertEqual(response.status_code, 200, response.text)
        fresh = response.json()["access_token"]
        self.assertNotEqual(fresh, self.alice_token)
        self.assertEqual((await self.client.get("/users/me", headers=self.bearer(fresh))).status_code, 200)
        self.assertEqual((await self.client.get("/users/me", headers=self.bearer(self.alice_token))).status_code, 401)
        self.assertEqual((await self.assign(ticket.id)).status_code, 409)
        async with self.Session() as db:
            saved = await db.get(SupportTicket, ticket.id)
            self.assertEqual(saved.status, "done")
            self.assertIsNone(saved.password_reset_by_id)

    async def test_bad_admin_confirmation_and_overlong_password_are_rejected(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        for password, confirmation in (("new-password-2", "different-password"), ("я" * 40, "я" * 40), (" " * 10, " " * 10)):
            result = await self.client.post(f"/admin/tickets/{ticket.id}/password", headers=self.bearer(self.owner_token),
                json={"new_password": password, "confirm_password": confirmation})
            self.assertEqual(result.status_code, 422)
        async with self.Session() as db:
            self.assertTrue(verify_password("old-password-1", (await db.get(User, self.alice.id)).password_hash))

    async def test_request_rate_limit_applies_even_for_unknown_accounts(self):
        with mock.patch.object(recovery, "REQUESTS_PER_HOUR", 1):
            self.assertEqual((await self.request_recovery("not-found-one")).status_code, 202)
            self.assertEqual((await self.request_recovery("not-found-two")).status_code, 429)

    async def test_legacy_tokens_are_invalid_after_password_change(self):
        async with self.Session() as db:
            user = await db.get(User, self.alice.id)
            legacy = jwt.encode({"sub": user.id, "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                                settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
            self.assertTrue(token_is_current(legacy, user))
        await self.request_recovery()
        (ticket,) = await self.tickets()
        await self.assign(ticket.id)
        self.assertEqual((await self.client.get("/users/me", headers=self.bearer(legacy))).status_code, 401)

    async def test_failure_rolls_back_password_status_and_audit_together(self):
        await self.request_recovery()
        (ticket,) = await self.tickets()
        original = recovery.passwords.complete_recoveries
        async def fail_after_flush(*args, **kwargs):
            await original(*args, **kwargs)
            raise RuntimeError("simulated transaction failure")
        with mock.patch.object(recovery.passwords, "complete_recoveries", fail_after_flush):
            result = await self.assign(ticket.id)
        self.assertEqual(result.status_code, 500)
        async with self.Session() as db:
            user = await db.get(User, self.alice.id)
            saved = await db.get(SupportTicket, ticket.id)
            self.assertTrue(verify_password("old-password-1", user.password_hash))
            self.assertIsNone(user.password_changed_at)
            self.assertIsNone(saved.password_reset_at)
            self.assertEqual(saved.status, "queued")

    async def test_self_reset_renews_the_admin_session_without_changing_admin_rights(self):
        await self.request_recovery("owner")
        (ticket,) = await self.tickets()
        result = await self.assign(ticket.id)
        self.assertEqual(result.status_code, 200, result.text)
        fresh = result.json()["access_token"]
        self.assertIsInstance(fresh, str)
        self.assertEqual((await self.client.get("/admin/tickets", headers=self.bearer(fresh))).status_code, 200)
        self.assertEqual((await self.client.get("/admin/tickets", headers=self.bearer(self.owner_token))).status_code, 404)

    async def test_login_cannot_mint_a_session_if_password_changed_while_it_was_verifying(self):
        old = User(id=self.alice.id, phone=self.alice.phone, username="alice", password_hash=hash_password("old-password-1"))
        changed = User(id=self.alice.id, phone=self.alice.phone, username="alice", password_hash=hash_password("new-password-2"))
        class Result:
            def __init__(self, value): self.value = value
            def scalar_one_or_none(self): return self.value
        db = mock.Mock(execute=mock.AsyncMock(side_effect=[Result(old), Result(changed)]))
        from app.schemas.user import UserLogin
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as error:
            await auth.login(UserLogin(phone=self.alice.phone, password="old-password-1"), db)
        self.assertEqual(error.exception.status_code, 401)

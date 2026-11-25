"""Журнал входов: почему человеку пришлось войти заново.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""
from datetime import timedelta

from sqlalchemy import select, update

from app.api import admin
from app.core import auth_log, device_sessions as sessions
from app.core.config import settings
from app.core.security import create_access_token, hash_password
from app.models.auth_event import AuthEvent
from app.models.device import DeviceSession
from app.models.user import User
from tests.test_device_pairing import PairingTestBase

BROWSER = "Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537"


class AuthLogTest(PairingTestBase):
    async def asyncSetUp(self):
        auth_log.reset_for_tests()
        await super().asyncSetUp()
        self.alice = self.users["alice"].id

    async def log_rows(self, user_id=None, event=None):
        async with self.Session() as db:
            query = select(AuthEvent).order_by(AuthEvent.at)
            if user_id:
                query = query.where(AuthEvent.user_id == user_id)
            if event:
                query = query.where(AuthEvent.event == event)
            return list((await db.execute(query)).scalars())

    async def me(self, token, **headers):
        return await self.client.get("/users/me", headers={"Authorization": f"Bearer {token}", **headers})

    async def test_first_use_of_a_password_token_is_a_login_with_its_method_and_device(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.alice).values(password_hash=hash_password("secret-pass")))
            await db.commit()
        response = await self.client.post("/auth/login", json={"phone": self.users["alice"].phone, "password": "secret-pass"})
        self.assertEqual(response.status_code, 200, response.text)
        token = response.json()["access_token"]
        for _ in range(2):
            self.assertEqual((await self.me(token, **{"User-Agent": BROWSER, "X-Quazar-Client": "desktop/2.8.0"})).status_code, 200)
        logins = [e for e in await self.log_rows(self.alice, "login") if e.reason == "password"]
        self.assertEqual(len(logins), 1)
        self.assertEqual((logins[0].client, logins[0].user_agent, logins[0].path), ("desktop/2.8.0", BROWSER, "GET /users/me"))
        self.assertIsNotNone(logins[0].session_id)

    async def test_wrong_password_is_logged_only_for_existing_accounts(self):
        await self.client.post("/auth/login", json={"phone": self.users["alice"].phone, "password": "wrong-pass"})
        await self.client.post("/auth/login", json={"phone": "+79999999999", "password": "wrong-pass"})
        failed = await self.log_rows(event="login_failed")
        self.assertEqual([(e.user_id, e.reason) for e in failed], [(self.alice, "wrong_password")])

    async def test_login_while_the_old_session_on_a_similar_device_still_lives_means_the_device_lost_it(self):
        # self.source — «Chrome · Windows» и всё ещё действует; новый вход с такого же браузера.
        token = create_access_token(self.alice, method="yandex")
        self.assertEqual((await self.me(token, **{"User-Agent": BROWSER})).status_code, 200)
        login = [e for e in await self.log_rows(self.alice, "login") if e.reason == "yandex"][0]
        self.assertTrue(login.detail.startswith(auth_log.LOST_ON_DEVICE), login.detail)
        async with self.Session() as db:
            me = await db.get(User, self.users["carol"].id)
            summary = await admin.auth_summary(me=me, db=db, days=30)
        self.assertEqual((summary.lost_on_device, summary.lost_on_device_users), (1, 1))
        self.assertEqual(summary.keep_days, settings.AUTH_LOG_DAYS)

    async def test_a_revoked_device_is_logged_with_who_ended_it_and_its_rejection_once(self):
        other = create_access_token(self.alice, method="phone_call")
        self.assertEqual((await self.me(other, **{"User-Agent": "Safari iPhone"})).status_code, 200)
        async with self.Session() as db:
            target = (await db.execute(select(DeviceSession).where(DeviceSession.token_hash == sessions.digest(other)))).scalar_one()
        response = await self.client.delete(f"/auth/devices/{target.id}", headers=self.headers)
        self.assertEqual(response.status_code, 204, response.text)
        for _ in range(3):
            self.assertEqual((await self.me(other)).status_code, 401)
        revoked = await self.log_rows(self.alice, "revoked")
        self.assertEqual([(e.reason, e.session_id) for e in revoked], [("device_list", target.id)])
        rejected = await self.log_rows(self.alice, "rejected")
        # Три отказа одного токена — одна запись.
        self.assertEqual([(e.reason, e.session_id) for e in rejected], [("session_revoked", target.id)])
        self.assertIn("iPhone", rejected[0].detail)

    async def test_a_session_unused_for_the_idle_period_is_rejected_as_expired(self):
        async with self.Session() as db:
            row = await db.get(DeviceSession, self.source.id)
            row.expires_at = sessions.now() - timedelta(minutes=1)
            await db.commit()
        self.assertEqual((await self.me(self.token)).status_code, 401)
        [event] = await self.log_rows(self.alice, "rejected")
        self.assertEqual(event.reason, "session_expired")
        self.assertIn("Последний заход", event.detail)

    async def test_password_change_and_revoke_all_are_told_apart(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.alice).values(password_changed_at=sessions.now()))
            await db.commit()
        self.assertEqual((await self.me(self.token)).status_code, 401)
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.users["bob"].id).values(sessions_revoked_at=sessions.now()))
            await db.commit()
        bob = create_access_token(self.users["bob"].id)
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.users["bob"].id).values(sessions_revoked_at=sessions.now() + timedelta(seconds=5)))
            await db.commit()
        self.assertEqual((await self.me(bob)).status_code, 401)
        reasons = {(e.user_id, e.reason) for e in await self.log_rows(event="rejected")}
        self.assertEqual(reasons, {(self.alice, "password_changed"), (self.users["bob"].id, "sessions_revoked")})

    async def test_logout_keeps_the_reason_the_app_gives(self):
        response = await self.client.delete("/auth/devices/current?reason=forget_device", headers=self.headers)
        self.assertEqual(response.status_code, 204, response.text)
        other = create_access_token(self.users["bob"].id)
        self.assertEqual((await self.me(other)).status_code, 200)
        await self.client.delete("/auth/devices/current?reason=whatever", headers={"Authorization": f"Bearer {other}"})
        logouts = await self.log_rows(event="logout")
        self.assertEqual([(e.user_id, e.reason) for e in logouts], [(self.alice, "forget_device"), (self.users["bob"].id, "unknown")])

    async def test_unreadable_token_is_logged_without_an_account(self):
        self.assertEqual((await self.me("garbage")).status_code, 401)
        [event] = await self.log_rows(event="rejected")
        self.assertEqual((event.reason, event.user_id), ("bad_token", None))

    async def test_admin_sees_the_users_log_with_labels(self):
        await self.client.delete("/auth/devices/current?reason=button", headers=self.headers)
        await self.me(self.token)
        async with self.Session() as db:
            me = await db.get(User, self.users["carol"].id)
            rows = await admin.user_auth_events(self.alice, me=me, db=db, limit=200)
        self.assertEqual([r.event for r in rows][:2], ["rejected", "logout"])
        self.assertEqual(rows[1].label, "Нажал «Выйти»")
        self.assertIn("завершён", rows[0].label)

    async def test_cleanup_keeps_only_the_retention_period(self):
        async with self.Session() as db:
            db.add_all([
                AuthEvent(at=sessions.now() - timedelta(days=settings.AUTH_LOG_DAYS + 1), event="login", reason="password"),
                AuthEvent(at=sessions.now() - timedelta(days=settings.AUTH_LOG_DAYS - 1), event="login", reason="password"),
            ])
            await db.commit()
        async with self.Session() as db:
            self.assertEqual(await auth_log.cleanup(db), 1)
            # Планировщик зовёт каждые 5 секунд — повторно в течение часа не чистит.
            self.assertEqual(await auth_log.cleanup(db), 0)
        self.assertEqual(len([e for e in await self.log_rows() if e.reason == "password"]), 1)

from datetime import timedelta

from sqlalchemy import func, select

from app.core import device_pairing as pairing, device_sessions as sessions
from app.core.config import settings
from app.core.security import create_access_token
from app.models.device import DeviceSession
from tests.test_device_pairing import PairingTestBase


class SessionLifetimeTest(PairingTestBase):
    """Сессия живёт, пока устройством пользуются, — а не неделю с момента входа."""

    async def age(self, session_id, *, seen_ago=timedelta(minutes=5), left=timedelta(hours=1)):
        async with self.Session() as db:
            row = await db.get(DeviceSession, session_id)
            row.last_seen_at = sessions.now() - seen_ago
            row.expires_at = sessions.now() + left
            await db.commit()

    async def deadline(self, session_id):
        async with self.Session() as db:
            return (await db.get(DeviceSession, session_id)).expires_at

    async def test_using_a_device_moves_its_deadline_forward(self):
        await self.age(self.source.id)
        response = await self.client.get("/users/me", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        left = await self.deadline(self.source.id) - sessions.now()
        self.assertGreater(left, timedelta(days=settings.SESSION_IDLE_DAYS) - timedelta(minutes=1))

    async def test_a_token_past_its_own_expiry_works_while_the_session_lives(self):
        # Так выглядят токены, выданные до перехода на скользящий срок: в них записано «7 дней».
        issued = sessions.now() - timedelta(days=8)
        token = create_access_token(self.users["alice"].id, issued_at=issued, expires_at=issued + timedelta(days=7))
        async with self.Session() as db:
            db.add(DeviceSession(id="old-phone", user_id=self.users["alice"].id, token_hash=sessions.digest(token),
                name="Chrome · Android", created_at=issued, issued_at=issued, last_seen_at=issued,
                expires_at=sessions.now() + timedelta(hours=1), token_expires_at=issued + timedelta(days=7)))
            await db.commit()
        response = await self.client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreater(await self.deadline("old-phone") - sessions.now(), timedelta(days=59))

    async def test_a_session_unused_for_the_idle_period_ends(self):
        await self.age(self.source.id, seen_ago=timedelta(days=settings.SESSION_IDLE_DAYS), left=-timedelta(seconds=1))
        response = await self.client.get("/users/me", headers=self.headers)
        self.assertEqual(response.status_code, 401)

    async def test_a_revoked_session_stays_revoked_however_active(self):
        response = await self.client.delete("/auth/devices/current", headers=self.headers)
        self.assertEqual(response.status_code, 204, response.text)
        self.assertEqual((await self.client.get("/users/me", headers=self.headers)).status_code, 401)

    async def test_an_expired_token_without_a_session_is_not_registered(self):
        issued = sessions.now() - timedelta(days=8)
        token = create_access_token(self.users["alice"].id, issued_at=issued, expires_at=issued + timedelta(days=7))
        async with self.Session() as db:
            before = (await db.execute(select(func.count()).select_from(DeviceSession))).scalar_one()
        response = await self.client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 401)
        async with self.Session() as db:
            self.assertEqual((await db.execute(select(func.count()).select_from(DeviceSession))).scalar_one(), before)

    async def test_a_new_token_session_gets_the_full_idle_period(self):
        token = create_access_token(self.users["alice"].id)
        response = await self.client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.Session() as db:
            row = (await db.execute(select(DeviceSession).where(DeviceSession.token_hash == sessions.digest(token)))).scalar_one()
        self.assertGreater(row.expires_at - sessions.now(), timedelta(days=59))
        self.assertLess(row.token_expires_at - sessions.now(), timedelta(days=8))

    async def test_a_linked_device_gets_the_same_token_again_after_its_session_moved(self):
        row = await self.approved()
        async with self.Session() as db:
            consumed, token = await pairing.consume(db, row.id, self.secret)
        await self.age(consumed.target_session_id)
        self.assertEqual((await self.client.get("/users/me", headers={"Authorization": f"Bearer {token}"})).status_code, 200)
        async with self.Session() as db:
            _, again = await pairing.consume(db, row.id, self.secret)
        self.assertEqual(again, token)

    async def test_signing_out_other_devices_keeps_this_one_for_the_idle_period(self):
        response = await self.client.delete("/auth/devices/others", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        token = response.json()["access_token"]
        self.assertEqual((await self.client.get("/users/me", headers={"Authorization": f"Bearer {token}"})).status_code, 200)
        async with self.Session() as db:
            row = await db.get(DeviceSession, self.source.id)
            self.assertEqual(sessions.token_for(row), token)
        self.assertGreater(row.expires_at - sessions.now(), timedelta(days=59))

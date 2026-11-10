import asyncio
import base64
import secrets
from datetime import timedelta
from unittest import mock

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import HTTPException
from sqlalchemy import func, select

from app.api import device_pairing as api
from app.core import device_pairing as pairing, device_sessions as sessions
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.security import create_access_token, decode_token
from app.core.config import settings
from app.main import app
from app.models.device import DevicePairing, DeviceSession
from app.models.user import User
from tests.stars_base import StarsTestBase


def key():
    private = X25519PrivateKey.generate()
    return base64.b64encode(private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()


class PairingTestBase(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.rkey, self.akey = key(), key()
        self.secret = secrets.token_urlsafe(32)
        self.token = create_access_token(self.users["alice"].id)
        async with self.Session() as db:
            self.source = await sessions.ensure(db, self.token, self.users["alice"], "Chrome/1 Windows")
        async def database():
            async with self.Session() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.addCleanup(app.dependency_overrides.clear)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://quazar-msg.ru")
        self.addAsyncCleanup(self.client.aclose)
        self.headers = {"Authorization": f"Bearer {self.token}"}

    async def request(self):
        async with self.Session() as db:
            return await pairing.start_request(db, self.rkey, self.secret, "Телефон")

    async def claimed(self):
        row, code = await self.request()
        async with self.Session() as db:
            row = await pairing.claim(db, self.users["alice"].id, self.source.id, self.akey,
                pair_id=None, code=code, expected_key=None)
        return row

    async def approved(self, *, cipher=None):
        row = await self.claimed()
        async with self.Session() as db:
            return await pairing.approve(db, row.id, self.users["alice"].id, self.source.id,
                pairing.binding(row), cipher, allow_without_keys=True)


class DevicePairingTest(PairingTestBase):
    async def test_request_contains_no_account_or_auth_token_before_confirmation(self):
        response = await self.client.post("/auth/device-pairing/requests", json={"public_key": self.rkey, "receiver_secret": self.secret, "device_name": "Телефон"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        data = response.json()
        self.assertEqual(len(data["code"]), 8)
        self.assertIsNone(data["request"]["account"])
        self.assertNotIn("access_token", data)
        async with self.Session() as db:
            row = await db.get(DevicePairing, data["request"]["id"])
            self.assertNotEqual(row.receiver_secret_hash, self.secret)
            self.assertNotEqual(row.code_hash, data["code"])

    async def test_both_directions_complete_and_consume_is_idempotent_for_the_same_device(self):
        row = await self.approved()
        async with self.Session() as db:
            result, token = await pairing.consume(db, row.id, self.secret)
            target_id = result.target_session_id
        async with self.Session() as db:
            repeated, again = await pairing.consume(db, row.id, self.secret)
            self.assertEqual(token, again)
            self.assertEqual(repeated.target_session_id, target_id)
            target = await db.get(DeviceSession, target_id)
            self.assertNotEqual(target.id, self.source.id)
            self.assertNotEqual(target.token_hash, token)
            self.assertLessEqual(target.expires_at, self.source.expires_at)
            self.assertIsNone((await db.get(User, self.users["alice"].id)).phone_verified_at)
        self.assertEqual(decode_token(token), self.users["alice"].id)

    async def test_browser_invitation_requires_approval_and_is_bound_to_receiver_keys(self):
        async with self.Session() as db:
            invite, secret = await pairing.create_invite(db, self.users["alice"].id, self.source.id, self.akey)
        async with self.Session() as db:
            row = await pairing.accept_invite(db, invite.id, secret, self.akey, self.rkey, self.secret, "Safari · iPhone")
        self.assertEqual(row.state, "claimed")
        async with self.Session() as db:
            again = await pairing.accept_invite(db, invite.id, secret, self.akey, self.rkey, self.secret, "Safari · iPhone")
            self.assertEqual(again.id, row.id)
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.consume(db, row.id, self.secret)
            self.assertEqual(caught.exception.status_code, 409)
        async with self.Session() as db:
            await pairing.approve(db, row.id, self.users["alice"].id, self.source.id, pairing.binding(row), None, False)
        async with self.Session() as db:
            _, token = await pairing.consume(db, row.id, self.secret)
            self.assertEqual(decode_token(token), self.users["alice"].id)
        async with self.Session() as db:
            with self.assertRaises(HTTPException):
                await pairing.accept_invite(db, invite.id, secret, self.akey, key(), secrets.token_urlsafe(32), "Другой телефон")

    async def test_scanned_qr_and_private_poll_secret_are_not_interchangeable(self):
        row, code = await self.request()
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.consume(db, row.id, code)
            self.assertEqual(caught.exception.status_code, 404)
        response = await self.client.post(f"/auth/device-pairing/requests/{row.id}/status", json={"receiver_secret": secrets.token_urlsafe(32)})
        self.assertEqual(response.status_code, 404)

    async def test_only_the_claiming_account_and_session_can_approve(self):
        row = await self.claimed()
        async with self.Session() as db:
            other, _ = await sessions.create(db, self.users["alice"], "Другое устройство")
            await db.commit()
        for uid, sid in [(self.users["bob"].id, self.source.id), (self.users["alice"].id, other.id)]:
            async with self.Session() as db:
                with self.assertRaises(HTTPException) as caught:
                    await pairing.approve(db, row.id, uid, sid, pairing.binding(row), None, True)
                self.assertEqual(caught.exception.status_code, 404)

    async def test_binding_mismatch_and_account_key_changes_are_rejected(self):
        row = await self.claimed()
        async with self.Session() as db:
            with self.assertRaises(HTTPException):
                await pairing.approve(db, row.id, self.users["alice"].id, self.source.id, "0" * 64, None, True)
        async with self.Session() as db:
            (await db.get(User, self.users["alice"].id)).public_key = key()
            await db.commit()
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.approve(db, row.id, self.users["alice"].id, self.source.id, pairing.binding(row), None, True)
            self.assertEqual(caught.exception.status_code, 409)

    async def test_existing_account_key_requires_transfer_or_explicit_opt_out(self):
        async with self.Session() as db:
            (await db.get(User, self.users["alice"].id)).public_key = key()
            await db.commit()
        row = await self.claimed()
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.approve(db, row.id, self.users["alice"].id, self.source.id, pairing.binding(row), None, False)
            self.assertEqual(caught.exception.status_code, 422)

    async def test_expired_rejected_and_revoked_requests_cannot_issue_tokens(self):
        for case in ["expired", "rejected", "source-revoked", "global-revoked", "blocked"]:
            if case in ["source-revoked", "global-revoked", "blocked"]:
                # Restore the source before preparing this independent request.
                async with self.Session() as db:
                    user = await db.get(User, self.users["alice"].id)
                    user.blocked_at = None; user.sessions_revoked_at = None
                    (await db.get(DeviceSession, self.source.id)).revoked_at = None
                    await db.commit()
            row = await self.approved()
            async with self.Session() as db:
                item = await db.get(DevicePairing, row.id)
                if case == "expired": item.expires_at = pairing.now() - timedelta(seconds=1)
                if case == "rejected": item.state = "rejected"
                if case == "source-revoked": (await db.get(DeviceSession, self.source.id)).revoked_at = pairing.now()
                if case == "global-revoked": (await db.get(User, self.users["alice"].id)).sessions_revoked_at = pairing.now()
                if case == "blocked": (await db.get(User, self.users["alice"].id)).blocked_at = pairing.now()
                await db.commit()
            async with self.Session() as db:
                with self.subTest(case=case), self.assertRaises(HTTPException):
                    await pairing.consume(db, row.id, self.secret)

    async def test_parallel_consumers_reuse_one_target_session(self):
        row = await self.approved()
        async def consume():
            async with self.Session() as db:
                return (await pairing.consume(db, row.id, self.secret))[1]
        first, second = await asyncio.gather(consume(), consume(), return_exceptions=True)
        self.assertIsInstance(first, str)
        self.assertEqual(first, second)
        async with self.Session() as db:
            count = (await db.execute(select(func.count()).select_from(DeviceSession))).scalar_one()
            self.assertEqual(count, 2)

    async def test_signer_rotation_invalidates_pending_grant(self):
        row = await self.approved()
        with mock.patch.object(settings, "JWT_SECRET", "test-rotated-signer"):
            async with self.Session() as db:
                with self.assertRaises(HTTPException) as caught:
                    await pairing.consume(db, row.id, self.secret)
                self.assertEqual(caught.exception.status_code, 409)

    async def test_consumed_grant_cannot_restore_a_revoked_session(self):
        row = await self.approved()
        async with self.Session() as db:
            consumed, _ = await pairing.consume(db, row.id, self.secret)
            (await db.get(DeviceSession, consumed.target_session_id)).revoked_at = sessions.now()
            await db.commit()
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.consume(db, row.id, self.secret)
            self.assertEqual(caught.exception.status_code, 410)

    async def test_local_websocket_revocation_keeps_other_sessions(self):
        target = mock.Mock(_quazar_session_id="target", close=mock.AsyncMock())
        other = mock.Mock(_quazar_session_id="other", close=mock.AsyncMock())
        with mock.patch.dict(sessions.manager.user_connections, {self.users["alice"].id: [target, other]}, clear=True):
            await sessions.close_connections(self.users["alice"].id, "target")
        target.close.assert_awaited_once_with(code=4001)
        other.close.assert_not_awaited()

    async def test_device_list_is_private_and_revocation_blocks_http(self):
        row = await self.approved()
        async with self.Session() as db:
            _, token = await pairing.consume(db, row.id, self.secret)
        response = await self.client.get("/auth/devices", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        entries = response.json()
        self.assertEqual(len(entries), 2)
        self.assertFalse(any("token_hash" in entry or "token_jti" in entry for entry in entries))
        target = next(entry for entry in entries if not entry["current"])
        await self.client.delete(f"/auth/devices/{target['id']}", headers=self.headers)
        denied = await self.client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(denied.status_code, 401)

    async def test_revoke_others_includes_unregistered_legacy_tokens(self):
        unknown_token = create_access_token(self.users["alice"].id)
        response = await self.client.delete("/auth/devices/others", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        new_token = response.json()["access_token"]
        self.assertEqual((await self.client.get("/users/me", headers=self.headers)).status_code, 401)
        self.assertEqual((await self.client.get("/users/me", headers={"Authorization": f"Bearer {unknown_token}"})).status_code, 401)
        self.assertEqual((await self.client.get("/users/me", headers={"Authorization": f"Bearer {new_token}"})).status_code, 200)

    async def test_other_account_cannot_revoke_my_session(self):
        bob = create_access_token(self.users["bob"].id)
        response = await self.client.delete(f"/auth/devices/{self.source.id}", headers={"Authorization": f"Bearer {bob}"})
        self.assertEqual(response.status_code, 404)

    async def test_old_tokens_are_registered_once_and_revocation_tombstones_are_kept(self):
        async with self.Session() as db:
            again = await sessions.ensure(db, self.token, self.users["alice"])
            self.assertEqual(again.id, self.source.id)
            again.revoked_at = sessions.now(); await db.commit()
        async with self.Session() as db:
            with self.assertRaises(HTTPException): await sessions.ensure(db, self.token, self.users["alice"])
        async with self.Session() as db:
            self.assertIsNotNone(await db.get(DeviceSession, self.source.id))

    async def test_code_attempts_are_rate_limited_and_low_order_curve_keys_are_invalid(self):
        with self.assertRaises(ValueError): pairing.validate_key(base64.b64encode(bytes(32)).decode())
        for _ in range(2):
            async with self.Session() as db: await pairing.rate_limit(db, "test", "client", limit=2)
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught: await pairing.rate_limit(db, "test", "client", limit=2)
            self.assertEqual(caught.exception.status_code, 429)


class KeyRequestTest(PairingTestBase):
    """Устройство уже вошло, но без ключа переписки: ключ передаёт другое устройство того же аккаунта."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.cipher = {"nonce": base64.b64encode(b"n" * 24).decode(), "ciphertext": base64.b64encode(b"c" * 48).decode()}
        self.phone_token = create_access_token(self.users["alice"].id)
        async with self.Session() as db:
            (await db.get(User, self.users["alice"].id)).public_key = key()
            await db.commit()
            self.phone = await sessions.ensure(db, self.phone_token, self.users["alice"], "Quazar Desktop")

    async def keys_request(self):
        async with self.Session() as db:
            return await pairing.start_key_request(db, self.users["alice"].id, self.phone.id, self.rkey, self.secret, "Quazar Desktop · Windows")

    async def sessions_count(self):
        async with self.Session() as db:
            return (await db.execute(select(func.count()).select_from(DeviceSession))).scalar_one()

    async def test_keys_move_to_a_signed_in_device_without_a_new_session(self):
        before = await self.sessions_count()
        row, code = await self.keys_request()
        self.assertEqual(row.kind, "keys")
        async with self.Session() as db:
            claimed = await pairing.claim(db, self.users["alice"].id, self.source.id, self.akey, pair_id=None, code=code, expected_key=None)
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.consume_keys(db, row.id, self.secret, self.users["alice"].id, self.phone.id)
            self.assertEqual(caught.exception.status_code, 409)
        async with self.Session() as db:
            await pairing.approve(db, row.id, self.users["alice"].id, self.source.id, pairing.binding(claimed), self.cipher, False)
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.consume(db, row.id, self.secret)
            self.assertEqual(caught.exception.status_code, 404)
        for session_id in (self.source.id, self.phone.id):
            async with self.Session() as db:
                if session_id == self.source.id:
                    with self.assertRaises(HTTPException) as caught:
                        await pairing.consume_keys(db, row.id, self.secret, self.users["alice"].id, session_id)
                    self.assertEqual(caught.exception.status_code, 404)
                else:
                    done = await pairing.consume_keys(db, row.id, self.secret, self.users["alice"].id, session_id)
                    self.assertEqual((done.state, done.encrypted_keys), ("consumed", self.cipher))
        self.assertEqual(await self.sessions_count(), before)

    async def test_only_another_device_of_the_same_account_can_claim(self):
        row, code = await self.keys_request()
        bob_token = create_access_token(self.users["bob"].id)
        async with self.Session() as db:
            bob = await sessions.ensure(db, bob_token, self.users["bob"], "Chrome")
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.claim(db, self.users["bob"].id, bob.id, self.akey, pair_id=None, code=code, expected_key=None)
            self.assertEqual(caught.exception.status_code, 404)
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.claim(db, self.users["alice"].id, self.phone.id, self.akey, pair_id=row.id, code=None, expected_key=self.rkey)
            self.assertEqual(caught.exception.status_code, 409)

    async def test_approval_must_carry_the_keys(self):
        row, code = await self.keys_request()
        async with self.Session() as db:
            claimed = await pairing.claim(db, self.users["alice"].id, self.source.id, self.akey, pair_id=None, code=code, expected_key=None)
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as caught:
                await pairing.approve(db, row.id, self.users["alice"].id, self.source.id, pairing.binding(claimed), None, True)
            self.assertEqual(caught.exception.status_code, 422)

    async def test_account_without_a_key_has_nothing_to_request(self):
        async with self.Session() as db:
            (await db.get(User, self.users["alice"].id)).public_key = None
            await db.commit()
        with self.assertRaises(HTTPException) as caught:
            await self.keys_request()
        self.assertEqual(caught.exception.status_code, 409)

    async def test_key_request_endpoints_need_the_requesting_session(self):
        body = {"public_key": self.rkey, "receiver_secret": self.secret, "device_name": "Quazar Desktop"}
        response = await self.client.post("/auth/device-pairing/key-requests", json=body)
        self.assertIn(response.status_code, (401, 403))
        with mock.patch.object(api.manager, "send_to_user", mock.AsyncMock()) as send:
            response = await self.client.post("/auth/device-pairing/key-requests", json=body, headers={"Authorization": f"Bearer {self.phone_token}"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        # Другие устройства узнают о запросе, но не получают ни кода, ни секрета.
        event = send.await_args.args[1]
        self.assertEqual((send.await_args.args[0], event["type"], event["id"]), (self.users["alice"].id, "device_key_request", data["request"]["id"]))
        self.assertNotIn(data["code"], str(event))
        self.assertNotIn(self.secret, str(event))
        self.assertEqual((data["request"]["kind"], len(data["code"])), ("keys", 8))
        pair_id = data["request"]["id"]
        consume = f"/auth/device-pairing/key-requests/{pair_id}/consume"
        response = await self.client.post(consume, json={"receiver_secret": self.secret}, headers=self.headers)
        self.assertEqual(response.status_code, 404)
        response = await self.client.post(consume, json={"receiver_secret": self.secret}, headers={"Authorization": f"Bearer {self.phone_token}"})
        self.assertEqual(response.status_code, 409)
        # Занятый или отменённый запрос убирается с остальных устройств.
        with mock.patch.object(api.manager, "send_to_user", mock.AsyncMock()) as send:
            response = await self.client.post("/auth/device-pairing/claim", json={"public_key": self.akey, "code": data["code"]}, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            response = await self.client.post(f"/auth/device-pairing/requests/{pair_id}/cancel", json={"receiver_secret": self.secret})
            self.assertEqual(response.status_code, 204, response.text)
        closed = {"type": "device_key_request_closed", "id": pair_id}
        self.assertEqual([call.args for call in send.await_args_list], [(self.users["alice"].id, closed)] * 2)


class DeviceKeyReportTest(PairingTestBase):
    """Устройства отмечают, есть ли на них ключ переписки, — чтобы подсказать, откуда его взять."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.account_key = key()
        self.phone_token = create_access_token(self.users["alice"].id)
        async with self.Session() as db:
            (await db.get(User, self.users["alice"].id)).public_key = self.account_key
            await db.commit()
            self.phone = await sessions.ensure(db, self.phone_token, self.users["alice"], "Телефон")
        self.phone_headers = {"Authorization": f"Bearer {self.phone_token}"}

    async def flags(self):
        response = await self.client.get("/auth/devices", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        rows = {row["id"]: row["has_account_key"] for row in response.json()}
        return {"source": rows[self.source.id], "phone": rows[self.phone.id]}

    async def test_devices_report_whether_they_hold_the_account_key(self):
        # Пока устройство не сообщало — неизвестно (старые версии приложения).
        self.assertEqual(await self.flags(), {"source": None, "phone": None})
        response = await self.client.put("/auth/devices/current/key", json={"public_key": self.account_key}, headers=self.headers)
        self.assertEqual(response.status_code, 204)
        await self.client.put("/auth/devices/current/key", json={"public_key": None}, headers=self.phone_headers)
        self.assertEqual(await self.flags(), {"source": True, "phone": False})

    async def test_a_foreign_or_rotated_key_does_not_count(self):
        await self.client.put("/auth/devices/current/key", json={"public_key": key()}, headers=self.phone_headers)
        await self.client.put("/auth/devices/current/key", json={"public_key": self.account_key}, headers=self.headers)
        self.assertEqual(await self.flags(), {"source": True, "phone": False})
        # Ключ аккаунта сменили на другом устройстве: прежняя отметка больше не совпадает.
        async with self.Session() as db:
            (await db.get(User, self.users["alice"].id)).public_key = key()
            await db.commit()
        self.assertEqual(await self.flags(), {"source": False, "phone": False})

    async def test_report_requires_a_live_session(self):
        response = await self.client.put("/auth/devices/current/key", json={"public_key": self.account_key})
        self.assertIn(response.status_code, (401, 403))
        await self.client.delete(f"/auth/devices/{self.phone.id}", headers=self.headers)
        response = await self.client.put("/auth/devices/current/key", json={"public_key": self.account_key}, headers=self.phone_headers)
        self.assertEqual(response.status_code, 401)

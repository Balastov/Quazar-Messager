import asyncio
import json
import threading
import time
from types import SimpleNamespace
from unittest import mock

import httpx
from fastapi import FastAPI
from sqlalchemy import select

from app.api import messages, notify as notify_api, push as push_api, stars, star_shares
from app.core import notify, push
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.chat import Chat, ChatMember
from app.models.push import PushSubscription
from app.models.user import User
from app.schemas.star import SendStarMessage
from tests.stars_base import StarsTestBase


class NotificationDeliveryTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pushes = []
        patcher = mock.patch.object(notify, "push_later", lambda ids, payload: self.pushes.append((ids, payload)))
        patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.object(push, "AsyncSessionLocal", self.Session)
        patcher.start(); self.addCleanup(patcher.stop)
        patcher = mock.patch.multiple(settings, VAPID_PUBLIC_KEY="test-public", VAPID_PRIVATE_KEY="test-private")
        patcher.start(); self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(channel for channel in self.star.channels if channel.kind == "satellite")
        async with self.Session() as db:
            chat = Chat(type="direct"); db.add(chat); await db.flush()
            self.chat_id = chat.id
            for who in ("alice", "bob"): db.add(ChatMember(chat_id=chat.id, user_id=self.users[who].id))
            await db.commit()
        self.app = FastAPI(); self.app.include_router(push_api.router)
        async def database():
            async with self.Session() as db: yield db
        self.app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    def uid(self, who): return self.users[who].id
    def bearer(self, who): return {"Authorization": "Bearer " + create_access_token(self.uid(who))}
    async def level(self, scope, target, level, who="bob"):
        await self.call(notify_api.set_notify, scope, target, notify_api.NotifyBody(level=level), user=who)

    async def send(self, payload="ENC2:secret-ciphertext", who="alice", reply=None, mentions=()):
        async with self.Session() as db:
            chat = await db.get(Chat, self.chat_id)
            return await messages.deliver(db, chat, self.uid(who), payload, reply_to=reply, notification_mentions=list(mentions))

    def targets(self): return set(uid for ids, _ in self.pushes for uid in ids)

    async def subscribe(self, endpoint, who="bob", **prefs):
        response = await self.client.post("/push/subscribe", headers=self.bearer(who), json={
            "endpoint": endpoint, "keys": {"p256dh": "test-p256dh", "auth": "test-auth"}, **prefs})
        self.assertEqual(response.status_code, 200, response.text)

    async def test_default_star_notifies_all_and_a_background_websocket_does_not_cancel_push(self):
        with mock.patch.dict(notify.manager.user_connections, {self.uid("bob"): [object()]}):
            await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="Обычное сообщение"), user="alice")
        self.assertEqual(self.targets(), {self.uid(who) for who in ("owner", "admin", "mod", "bob")})

    async def test_mentions_and_replies_are_separate_for_star_messages_and_threads(self):
        for who in ("owner", "admin", "mod"): await self.level("star", self.star.id, "none", who)
        await self.level("channel", self.sat.id, "mentions_only")
        root = await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="Вопрос"), user="bob")
        self.pushes.clear()
        await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="Ответ", reply_to_id=root.id), user="alice")
        self.assertNotIn(self.uid("bob"), self.targets())
        self.pushes.clear()
        await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="@bob посмотри"), user="alice")
        self.assertEqual(self.targets(), {self.uid("bob")})
        await self.level("channel", self.sat.id, "replies")
        self.pushes.clear()
        await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="@bob просто упоминание"), user="alice")
        self.assertNotIn(self.uid("bob"), self.targets())
        self.pushes.clear()
        reply = await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="В ветке", thread_id=root.id), user="alice")
        self.assertEqual(reply.thread_author_id, self.uid("bob"))
        self.assertEqual(self.targets(), {self.uid("bob")})

    async def test_encrypted_direct_push_contains_no_message_text_and_filters_mention_metadata(self):
        await self.level("chat", self.chat_id, "mentions_only")
        await self.send(mentions=[self.uid("carol")])
        self.assertEqual(self.targets(), set())
        self.pushes.clear()
        message = await self.send(mentions=[self.uid("bob"), self.uid("carol")])
        self.assertEqual(self.targets(), {self.uid("bob")})
        payload = self.pushes[-1][1]
        self.assertEqual(payload["body"], "Новое сообщение")
        self.assertEqual(payload["message_id"], message.id)
        self.assertNotIn("secret-ciphertext", json.dumps(payload))

    async def test_direct_reply_filter_and_explicit_mute_and_dnd(self):
        root = await self.send(who="bob")
        await self.level("chat", self.chat_id, "replies")
        self.pushes.clear(); await self.send(mentions=[self.uid("bob")])
        self.assertEqual(self.targets(), set())
        self.pushes.clear(); await self.send(reply=root)
        self.assertEqual(self.targets(), {self.uid("bob")})
        await self.level("chat", self.chat_id, "none")
        self.pushes.clear(); await self.send(reply=root)
        self.assertEqual(self.targets(), set())
        await self.level("chat", self.chat_id, "all")
        async with self.Session() as db:
            user = await db.get(User, self.uid("bob")); user.manual_status = "dnd"; await db.commit()
        self.pushes.clear(); await self.send()
        self.assertEqual(self.targets(), set())

    async def test_ack_is_scoped_to_user_and_device_and_never_suppresses_another_device(self):
        a, b = "https://push-a.example/device", "https://push-b.example/device"
        await self.subscribe(a); await self.subscribe(b)
        body = {"endpoint": a, "message_ids": ["message-1"]}
        await self.client.post("/push/ack", headers=self.bearer("alice"), json=body)
        async with self.Session() as db:
            row = (await db.execute(select(PushSubscription).where(PushSubscription.endpoint == a))).scalar_one()
            self.assertFalse(row.recent_message_ids)
        await self.client.post("/push/ack", headers=self.bearer("bob"), json=body)
        sent = []
        with mock.patch("pywebpush.webpush", side_effect=lambda **kwargs: sent.append(kwargs)):
            self.assertEqual(await push.send_push_to_user(self.uid("bob"), {"type": "star_message", "message_id": "message-1"}), 1)
        self.assertEqual([item["subscription_info"]["endpoint"] for item in sent], [b])

    async def test_push_runs_outside_event_loop_with_independent_claims_ttl_and_device_sound(self):
        await self.subscribe("https://push-a.example/device", sound=False)
        await self.subscribe("https://push-b.example/device")
        main_thread = threading.get_ident(); calls = []
        def send(**kwargs):
            calls.append((threading.get_ident(), dict(kwargs["vapid_claims"]), kwargs))
            kwargs["vapid_claims"]["aud"] = kwargs["subscription_info"]["endpoint"]
            time.sleep(0.04)
        with mock.patch("pywebpush.webpush", side_effect=send):
            self.assertEqual(await push.send_push_to_user(self.uid("bob"), {"type": "chat_message", "message_id": "message-2"}), 2)
        self.assertTrue(all(thread != main_thread for thread, _, _ in calls))
        self.assertTrue(all("aud" not in initial for _, initial, _ in calls))
        self.assertTrue(all(call[2]["ttl"] == 86400 and call[2]["timeout"] == 10 for call in calls))
        payloads = {call[2]["subscription_info"]["endpoint"]: json.loads(call[2]["data"]) for call in calls}
        self.assertTrue(payloads["https://push-a.example/device"]["silent"])
        self.assertFalse(payloads["https://push-b.example/device"]["silent"])

    async def test_disabled_device_is_skipped_and_expired_subscription_does_not_break_other_devices(self):
        from pywebpush import WebPushException
        await self.subscribe("https://disabled.example/device", enabled=False)
        self.assertFalse(await push.user_has_push(self.uid("bob")))
        await self.subscribe("https://expired.example/device")
        await self.subscribe("https://healthy.example/device")
        self.assertTrue(await push.user_has_push(self.uid("bob")))
        sent = []
        def send(**kwargs):
            endpoint = kwargs["subscription_info"]["endpoint"]; sent.append(endpoint)
            if "expired" in endpoint: raise WebPushException("expired", response=SimpleNamespace(status_code=410))
        with mock.patch("pywebpush.webpush", side_effect=send):
            self.assertEqual(await push.send_push_to_user(self.uid("bob"), {"type": "chat_message"}), 1)
        self.assertNotIn("https://disabled.example/device", sent)
        async with self.Session() as db:
            endpoints = set((await db.execute(select(PushSubscription.endpoint))).scalars())
            self.assertNotIn("https://expired.example/device", endpoints)
            self.assertIn("https://healthy.example/device", endpoints)

    async def test_shared_channel_push_opens_the_recipients_star(self):
        guest = await self.make_star(kind="work", user="carol", name="Гостевая")
        invite = await self.call(star_shares.create_share_invite, self.star.id, self.sat.id, user="owner")
        await self.call(star_shares.accept_invite, invite.code, star_shares.AcceptBody(star_id=guest.id), user="carol")
        self.pushes.clear()
        await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="Для двух Звёзд"), user="alice")
        received = [payload for ids, payload in self.pushes if self.uid("carol") in ids]
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["star_id"], guest.id)
        self.assertIn("Гостевая", received[0]["title"])
        await self.level("channel", self.sat.id, "none", "carol")
        self.pushes.clear()
        await self.call(stars.send_message, self.star.id, self.sat.id, SendStarMessage(text="Уважать отключение гостя"), user="alice")
        self.assertNotIn(self.uid("carol"), self.targets())

    async def test_new_notification_fields_migrate_without_resetting_existing_choices(self):
        from app import main
        from app.models.notify import NotifySetting
        from app.models.message import ScheduledMessage
        from sqlalchemy import text
        await self.level("star", self.star.id, "mentions")
        await self.subscribe("https://legacy.example/device")
        async with self.engine.begin() as conn:
            await conn.execute(text("ALTER TABLE notify_settings ALTER COLUMN level TYPE VARCHAR(8)"))
            await conn.execute(text("ALTER TABLE push_subscriptions DROP COLUMN enabled"))
            await conn.execute(text("ALTER TABLE push_subscriptions DROP COLUMN sound"))
            await conn.execute(text("ALTER TABLE push_subscriptions DROP COLUMN recent_message_ids"))
            await conn.execute(text("ALTER TABLE scheduled_messages DROP COLUMN notification_mentions"))
        with mock.patch.object(main, "engine", self.engine), mock.patch.object(main, "AsyncSessionLocal", self.Session), \
                mock.patch.object(main.voice, "resync", new_callable=mock.AsyncMock), \
                mock.patch.object(main.attachments, "sweep_forever", new_callable=mock.AsyncMock), \
                mock.patch.object(main.scheduler, "run_forever", new_callable=mock.AsyncMock):
            async with main.lifespan(FastAPI()):
                async with self.Session() as db:
                    setting = await db.get(NotifySetting, (self.uid("bob"), "star", self.star.id))
                    self.assertEqual(setting.level, "mentions")
                    sub = (await db.execute(select(PushSubscription))).scalar_one()
                    self.assertTrue(sub.enabled); self.assertTrue(sub.sound)
                    self.assertFalse(sub.recent_message_ids)
                    await db.execute(select(ScheduledMessage.notification_mentions).limit(1))
                    setting.level = "mentions_only"
                    await db.commit()

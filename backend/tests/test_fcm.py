"""Уведомления в приложение для Android через Firebase Cloud Messaging.

Firebase не вызывается: запросы к Google перехватывает httpx.MockTransport.
Тесты с базой (регистрация телефона, отправка, удаление недействительных адресов) — на PostgreSQL.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from jose import jwt
from sqlalchemy import select

from app.api import push as push_api
from app.core import fcm, push
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.push import FcmDevice
from tests.stars_base import StarsTestBase

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIVATE_PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
PUBLIC_PEM = KEY.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def write_account(folder: str) -> str:
    path = Path(folder) / "firebase.json"
    path.write_text(json.dumps({
        "type": "service_account", "project_id": "quazar-test", "client_email": "fcm@quazar-test.iam.gserviceaccount.com",
        "private_key": PRIVATE_PEM, "token_uri": "https://oauth2.googleapis.com/token",
    }))
    return str(path)


class FakeGoogle:
    """Подменяет oauth2.googleapis.com и fcm.googleapis.com."""

    def __init__(self):
        self.token_requests: list[dict] = []
        self.sent: list[dict] = []
        self.answers: dict[str, httpx.Response] = {}
        self.token_answer: httpx.Response | None = None
        self.offline: set[str] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host in self.offline:
            raise httpx.ConnectError("unreachable", request=request)
        if request.url.host == "oauth2.googleapis.com" and self.token_answer is not None:
            return self.token_answer
        if request.url.host == "oauth2.googleapis.com":
            form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
            self.token_requests.append(form)
            return httpx.Response(200, json={"access_token": f"access-{len(self.token_requests)}", "expires_in": 3600})
        body = json.loads(request.content)
        self.sent.append({"url": str(request.url), "auth": request.headers["authorization"], **body})
        return self.answers.get(body["message"]["token"], httpx.Response(200, json={"name": "projects/x/messages/1"}))

    def patch(self, case: unittest.TestCase):
        transport = httpx.MockTransport(self.handler)
        patcher = mock.patch.object(fcm, "_client", lambda: httpx.AsyncClient(transport=transport, timeout=10))
        patcher.start()
        case.addCleanup(patcher.stop)


class MessageMappingTest(unittest.TestCase):
    def test_each_event_looks_like_the_web_notification(self):
        call = fcm.message_for({"type": "incoming_call", "call_id": "c1", "chat_id": "ch", "caller_name": "Анна",
                                "media": {"video": True}})
        self.assertEqual(call["notification"], {"title": "Входящий видеозвонок", "body": "Анна"})
        self.assertEqual(call["data"], {"kind": "call", "callId": "c1", "chatId": "ch", "callerName": "Анна", "video": "1"})
        self.assertEqual(call["android"]["notification"]["channel_id"], "calls")
        self.assertEqual(call["android"]["notification"]["notification_priority"], "PRIORITY_MAX")
        self.assertEqual(call["android"]["ttl"], f"{settings.CALL_RING_TIMEOUT_SEC}s")

        chat = fcm.message_for({"type": "chat_message", "title": "Боб", "chat_id": "ch", "message_id": "m"})
        self.assertEqual(chat["notification"]["body"], "Новое сообщение")
        self.assertEqual(chat["android"]["notification"]["tag"], "quazar-chat-ch")
        self.assertEqual(chat["android"]["notification"]["channel_id"], "messages")
        self.assertEqual(chat["data"], {"kind": "message", "chatId": "ch"})

        star = fcm.message_for({"type": "star_message", "title": "#общий", "body": "Привет", "star_id": "s",
                                "channel_id": "c", "message_id": "m", "thread_id": None})
        self.assertEqual(star["data"], {"kind": "star", "starId": "s", "channelId": "c", "messageId": "m"})

        door = fcm.message_for({"type": "star_door", "title": "Анна зовёт вас", "body": "в Переговорную",
                                "star_id": "s", "channel_id": "c", "door": "invite"})
        self.assertEqual(door["android"]["notification"]["channel_id"], "rooms")
        self.assertEqual(door["android"]["ttl"], "300s")
        self.assertEqual(door["data"]["door"], "invite")

        inbox = fcm.message_for({"type": "inbox", "title": "Встреча", "body": "Через 10 минут", "notification_id": "n",
                                 "star_id": "s", "channel_id": "c"})
        self.assertEqual(inbox["data"], {"kind": "inbox", "starId": "s", "channelId": "c", "messageId": "n"})

        keys = fcm.message_for({"type": "device_key_request", "request_id": "r"})
        self.assertEqual(keys["notification"]["title"], "Вход в Quazar на новом устройстве")
        self.assertEqual(keys["data"], {"kind": "keys"})

        # Проверка связи — только для web push конкретного браузера.
        self.assertIsNone(fcm.message_for({"type": "connection_test"}))
        # Все значения данных — строки (так требует FCM).
        for message in (call, chat, star, door, inbox, keys):
            self.assertTrue(all(isinstance(v, str) for v in message["data"].values()))


class SendTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        fcm.reset()
        self.addCleanup(fcm.reset)
        self.folder = tempfile.mkdtemp()
        patcher = mock.patch.object(settings, "FIREBASE_SERVICE_ACCOUNT_FILE", write_account(self.folder))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.google = FakeGoogle()
        self.google.patch(self)

    async def test_signs_in_with_the_service_account_and_reuses_the_token(self):
        ok, stale = await fcm.send(["token-a", "token-b"], {"type": "chat_message", "title": "Боб", "chat_id": "ch"})
        self.assertEqual((ok, stale), (2, []))
        await fcm.send(["token-a"], {"type": "chat_message", "title": "Боб", "chat_id": "ch"})
        self.assertEqual(len(self.google.token_requests), 1)
        claims = jwt.decode(self.google.token_requests[0]["assertion"], PUBLIC_PEM, algorithms=["RS256"],
                            audience="https://oauth2.googleapis.com/token")
        self.assertEqual(claims["iss"], "fcm@quazar-test.iam.gserviceaccount.com")
        self.assertEqual(claims["scope"], fcm.SCOPE)
        self.assertEqual(self.google.sent[0]["url"], "https://fcm.googleapis.com/v1/projects/quazar-test/messages:send")
        self.assertEqual(self.google.sent[0]["auth"], "Bearer access-1")
        self.assertEqual({s["message"]["token"] for s in self.google.sent[:2]}, {"token-a", "token-b"})

    async def test_reports_uninstalled_apps(self):
        self.google.answers["gone"] = httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
        self.google.answers["unregistered"] = httpx.Response(400, json={"error": {"status": "INVALID_ARGUMENT", "details": [
            {"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": "UNREGISTERED"}]}})
        self.google.answers["busy"] = httpx.Response(503, json={"error": {"status": "UNAVAILABLE"}})
        ok, stale = await fcm.send(["fine", "gone", "unregistered", "busy"], {"type": "chat_message", "chat_id": "ch"})
        self.assertEqual(ok, 1)
        self.assertEqual(sorted(stale), ["gone", "unregistered"])

    async def test_a_key_from_another_project_is_reported_but_keeps_the_phone(self):
        self.google.answers["phone"] = httpx.Response(403, json={"error": {"status": "PERMISSION_DENIED", "details": [
            {"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": "SENDER_ID_MISMATCH"}]}})
        with self.assertLogs("app.core.fcm", "WARNING") as logs:
            ok, stale = await fcm.send(["phone"], {"type": "chat_message", "chat_id": "c"})
        self.assertEqual((ok, stale), (0, []))
        self.assertIn("SENDER_ID_MISMATCH", "\n".join(logs.output))
        outcome = (await fcm.deliver(["phone"], {"type": "app_push_test"}))[0]
        self.assertFalse(outcome.ok)
        self.assertFalse(outcome.stale)
        self.assertIn("другого проекта", outcome.reason)

    async def test_explains_why_google_refused(self):
        self.google.token_answer = httpx.Response(400, json={"error": "invalid_grant", "error_description": "Invalid JWT Signature."})
        with self.assertLogs("app.core.fcm", "WARNING"):
            outcome = (await fcm.deliver(["phone"], {"type": "app_push_test"}))[0]
        self.assertEqual(outcome.status, 400)
        self.assertIn("Invalid JWT Signature", outcome.reason)

        fcm.reset()
        self.google.token_answer = None
        self.google.offline = {"oauth2.googleapis.com"}
        with self.assertLogs("app.core.fcm", "WARNING"):
            outcome = (await fcm.deliver(["phone"], {"type": "app_push_test"}))[0]
        self.assertIn("Нет связи с Google", outcome.reason)

        self.google.offline = {"fcm.googleapis.com"}
        with self.assertLogs("app.core.fcm", "WARNING"):
            outcome = (await fcm.deliver(["phone"], {"type": "app_push_test"}))[0]
        self.assertIn("Нет связи с Firebase", outcome.reason)

    async def test_silent_without_a_key(self):
        with mock.patch.object(settings, "FIREBASE_SERVICE_ACCOUNT_FILE", str(Path(self.folder) / "missing.json")):
            self.assertFalse(fcm.configured())
            self.assertEqual(await fcm.send(["t"], {"type": "chat_message"}), (0, []))
        bad = Path(self.folder) / "bad.json"
        bad.write_text("{}")
        with mock.patch.object(settings, "FIREBASE_SERVICE_ACCOUNT_FILE", str(bad)):
            self.assertFalse(fcm.configured())
        self.assertEqual(self.google.sent, [])


class DevicesTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        fcm.reset()
        self.addCleanup(fcm.reset)
        folder = tempfile.mkdtemp()
        for patcher in (
            mock.patch.object(settings, "FIREBASE_SERVICE_ACCOUNT_FILE", write_account(folder)),
            mock.patch.multiple(settings, VAPID_PUBLIC_KEY="", VAPID_PRIVATE_KEY=""),
            mock.patch.object(push, "AsyncSessionLocal", self.Session),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.google = FakeGoogle()
        self.google.patch(self)
        app = FastAPI()
        app.include_router(push_api.router)

        async def database():
            async with self.Session() as db:
                yield db

        app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    def bearer(self, who):
        return {"Authorization": "Bearer " + create_access_token(self.users[who].id)}

    async def register(self, token, who):
        response = await self.client.put("/push/fcm", headers=self.bearer(who), json={"token": token, "app_version": "2.5.0"})
        self.assertEqual(response.status_code, 200, response.text)

    async def tokens(self, who):
        async with self.Session() as db:
            return set((await db.execute(select(FcmDevice.token).where(FcmDevice.user_id == self.users[who].id))).scalars())

    async def test_phone_registers_moves_between_accounts_and_unregisters(self):
        self.assertTrue((await self.client.get("/push/fcm")).json()["configured"])
        phone = "phone-token-" + "x" * 30
        await self.register(phone, "alice")
        await self.register(phone, "alice")
        self.assertEqual(await self.tokens("alice"), {phone})
        # Тот же телефон, другой аккаунт — уведомления Алисы туда больше не идут.
        await self.register(phone, "bob")
        self.assertEqual(await self.tokens("alice"), set())
        self.assertEqual(await self.tokens("bob"), {phone})
        unauth = await self.client.put("/push/fcm", json={"token": phone})
        self.assertIn(unauth.status_code, (401, 403))
        # Выход из аккаунта: адрес знает только само приложение.
        response = await self.client.post("/push/fcm/unregister", json={"token": phone})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(await self.tokens("bob"), set())

    async def test_check_from_the_phone_tells_what_happened(self):
        phone = "phone-token-" + "c" * 30
        test = lambda token, who="bob": self.client.post("/push/fcm/test", headers=self.bearer(who), json={"token": token})  # noqa: E731
        response = await test(phone)
        self.assertFalse(response.json()["ok"])
        self.assertIn("не зарегистрирован", response.json()["error"])

        await self.register(phone, "bob")
        response = await test(phone)
        self.assertEqual(response.json(), {"ok": True, "status": 200, "error": None})
        self.assertEqual(self.google.sent[-1]["message"]["notification"]["title"], "Quazar — проверка уведомлений")
        # Чужой телефон проверить нельзя.
        self.assertFalse((await test(phone, who="alice")).json()["ok"])

        self.google.answers[phone] = httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
        response = await test(phone)
        self.assertIn("больше не знает", response.json()["error"])
        self.assertEqual(await self.tokens("bob"), set())

    async def test_push_reaches_the_phone_and_forgets_uninstalled_apps(self):
        fresh, gone = "fresh-token-" + "a" * 30, "gone-token-" + "b" * 30
        await self.register(fresh, "bob")
        await self.register(gone, "bob")
        self.google.answers[gone] = httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
        self.assertTrue(await push.user_has_push(self.users["bob"].id))
        self.assertFalse(await push.user_has_push(self.users["alice"].id))

        sent = await push.send_push_to_user(self.users["bob"].id, {"type": "chat_message", "title": "Alice", "chat_id": "c"})
        self.assertEqual(sent, 1)
        self.assertEqual(await self.tokens("bob"), {fresh})
        self.assertEqual(self.google.sent[0]["message"]["notification"]["title"], "Alice")

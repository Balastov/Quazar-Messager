"""Уведомления приложения Quazar для Android через Firebase Cloud Messaging (HTTP v1 API).

Ключ сервисного аккаунта Firebase лежит в файле (FIREBASE_SERVICE_ACCOUNT_FILE); по нему сервер сам
получает короткий токен доступа Google (JWT RS256 → oauth2) и шлёт уведомления на телефоны.
Нет файла — модуль молчит, как web push без VAPID-ключей.

Уведомления те же, что у web push (`send_push_to_user`), и выглядят так же, как в сервис-воркере
(web/public/sw.js): заголовок, текст, «тег» (новое уведомление того же чата заменяет прежнее) и
данные для перехода по нажатию — их разбирает web/src/platform/androidPush.ts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx
from jose import jwt

from app.core.config import settings

logger = logging.getLogger(__name__)

SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
SEND_URL = "https://fcm.googleapis.com/v1/projects/{project}/messages:send"

# Каналы уведомлений Android (их создаёт приложение): человек может настроить каждый в системе.
CHANNEL_MESSAGES = "messages"
CHANNEL_CALLS = "calls"
CHANNEL_ROOMS = "rooms"
CHANNEL_GENERAL = "general"


@dataclass(frozen=True)
class Account:
    project_id: str
    client_email: str
    private_key: str
    token_uri: str


_account: tuple[str, float, Account | None] | None = None
_token: tuple[str, float, str] | None = None  # (client_email, истекает, токен)
_token_lock: asyncio.Lock | None = None


def account() -> Account | None:
    """Ключ сервисного аккаунта из файла; перечитывается, если файл поменяли."""
    global _account
    path = settings.FIREBASE_SERVICE_ACCOUNT_FILE.strip()
    if not path:
        return None
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return None
    if _account and _account[0] == path and _account[1] == mtime:
        return _account[2]
    parsed: Account | None = None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("type") == "service_account":
            parsed = Account(
                project_id=str(data["project_id"]),
                client_email=str(data["client_email"]),
                private_key=str(data["private_key"]),
                token_uri=str(data.get("token_uri") or "https://oauth2.googleapis.com/token"),
            )
    except (OSError, ValueError, KeyError, TypeError):
        parsed = None
    if parsed is None:
        logger.warning("FIREBASE_SERVICE_ACCOUNT_FILE is not a Firebase service account key")
    _account = (path, mtime, parsed)
    return parsed


def configured() -> bool:
    return account() is not None


def reset() -> None:
    """Для тестов: забыть ключ и токен."""
    global _account, _token, _token_lock
    _account = _token = _token_lock = None


async def _access_token(client: httpx.AsyncClient, acc: Account) -> str:
    """Токен доступа Google на час; берём новый за 5 минут до конца."""
    global _token, _token_lock
    if _token and _token[0] == acc.client_email and _token[1] - 300 > time.time():
        return _token[2]
    if _token_lock is None:
        _token_lock = asyncio.Lock()
    async with _token_lock:
        if _token and _token[0] == acc.client_email and _token[1] - 300 > time.time():
            return _token[2]
        now = int(time.time())
        assertion = jwt.encode(
            {"iss": acc.client_email, "scope": SCOPE, "aud": acc.token_uri, "iat": now, "exp": now + 3600},
            acc.private_key,
            algorithm="RS256",
        )
        response = await client.post(
            acc.token_uri,
            data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        )
        response.raise_for_status()
        data = response.json()
        _token = (acc.client_email, now + int(data.get("expires_in", 3600)), data["access_token"])
        return _token[2]


def _ttl(payload: dict[str, Any]) -> int:
    kind = payload.get("type")
    default = settings.CALL_RING_TIMEOUT_SEC if kind == "incoming_call" else 300 if kind == "star_door" else 86400
    return max(1, min(86400, int(payload.get("ttl", default))))


def message_for(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Уведомление Android для события сервера (то же, что показывает sw.js). None — не слать."""
    kind = payload.get("type")
    title = payload.get("title") or "Quazar"
    body = payload.get("body") or ""
    channel = CHANNEL_GENERAL
    if kind == "connection_test":
        # Проверка связи — про web push конкретного браузера.
        return None
    if kind == "incoming_call":
        video = bool((payload.get("media") or {}).get("video"))
        title = "Входящий видеозвонок" if video else "Входящий звонок"
        body = payload.get("caller_name") or "Собеседник"
        tag = f"quazar-call-{payload.get('call_id') or 'x'}"
        data = {"kind": "call", "callId": payload.get("call_id"), "chatId": payload.get("chat_id"),
                "callerId": payload.get("caller_id"), "callerName": body, "video": "1" if video else "0"}
        channel = CHANNEL_CALLS
    elif kind == "star_door":
        tag = f"quazar-door-{payload.get('knock_id') or payload.get('channel_id') or 'x'}"
        data = {"kind": "door", "starId": payload.get("star_id"), "channelId": payload.get("channel_id"),
                "door": payload.get("door") or "invite", "knockId": payload.get("knock_id"),
                "lobbyChannelId": payload.get("lobby_channel_id")}
        channel = CHANNEL_ROOMS
    elif kind == "device_key_request":
        title = payload.get("title") or "Вход в Quazar на новом устройстве"
        body = body or "Откройте Quazar, чтобы подтвердить, что это вы."
        tag = f"quazar-keys-{payload.get('request_id') or 'x'}"
        data = {"kind": "keys"}
    elif kind == "inbox":
        tag = payload.get("tag") or f"quazar-inbox-{payload.get('notification_id') or 'x'}"
        data = {"kind": "inbox", "starId": payload.get("star_id"), "channelId": payload.get("channel_id"),
                "messageId": payload.get("notification_id")}
    elif kind == "star_message":
        tag = f"quazar-star-{payload.get('channel_id') or 'x'}"
        data = {"kind": "star", "starId": payload.get("star_id"), "channelId": payload.get("channel_id"),
                "messageId": payload.get("message_id"), "threadId": payload.get("thread_id")}
        channel = CHANNEL_MESSAGES
    elif kind == "chat_message":
        # Текст личных сообщений зашифрован — серверу он не виден.
        body = body or "Новое сообщение"
        tag = f"quazar-chat-{payload.get('chat_id') or payload.get('message_id') or 'x'}"
        data = {"kind": "message", "chatId": payload.get("chat_id")}
        channel = CHANNEL_MESSAGES
    else:
        body = body or "Новое уведомление"
        tag = payload.get("tag") or "quazar-push"
        data = {"kind": "message", "chatId": payload.get("chatId") or payload.get("chat_id")}
    return {
        "notification": {"title": str(title)[:200], "body": str(body)[:1000]},
        # В FCM данные — только строки.
        "data": {k: str(v) for k, v in data.items() if v not in (None, "")},
        "android": {
            # Высокий приоритет: телефон в режиме сна получит уведомление сразу, а не пачкой потом.
            "priority": "high",
            "ttl": f"{_ttl(payload)}s",
            "notification": {
                "channel_id": channel,
                "tag": tag,
                "default_sound": True,
                "notification_priority": "PRIORITY_MAX" if channel == CHANNEL_CALLS else "PRIORITY_HIGH",
            },
        },
    }


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10)


def _stale(response: httpx.Response) -> bool:
    """Адрес устройства больше не действует: приложение удалили или переустановили."""
    if response.status_code == 404:
        return True
    try:
        details = response.json().get("error", {}).get("details", [])
    except ValueError:
        return False
    codes = {d.get("errorCode") for d in details if isinstance(d, dict)}
    return bool(codes & {"UNREGISTERED", "SENDER_ID_MISMATCH"})


async def send(tokens: list[str], payload: dict[str, Any]) -> tuple[int, list[str]]:
    """Отправить уведомление на устройства. Возвращает (сколько доставлено в FCM, недействительные адреса)."""
    global _token
    acc = account()
    message = message_for(payload)
    if not acc or not message or not tokens:
        return 0, []
    async with _client() as client:
        try:
            access = await _access_token(client, acc)
        except Exception as exc:  # noqa: BLE001 — сеть или ключ: остальные уведомления это не держит
            logger.warning("fcm auth failed: %s", type(exc).__name__)
            return 0, []
        url = SEND_URL.format(project=acc.project_id)

        async def one(token: str) -> tuple[bool, str | None]:
            try:
                response = await client.post(
                    url, json={"message": {**message, "token": token}}, headers={"Authorization": f"Bearer {access}"}
                )
            except httpx.HTTPError:
                logger.info("fcm transport error")
                return False, None
            if response.status_code == 200:
                return True, None
            if response.status_code == 401:
                # Токен доступа отозван раньше срока — в следующий раз возьмём новый.
                _token = None
            if _stale(response):
                return False, token
            logger.info("fcm rejected (status=%s)", response.status_code)
            return False, None

        results = await asyncio.gather(*(one(t) for t in tokens))
    return sum(1 for ok, _ in results if ok), [t for _, t in results if t]

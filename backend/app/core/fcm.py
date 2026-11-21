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
    if kind == "app_push_test":
        # Проверка уведомлений из настроек приложения для Android.
        return {
            "notification": {"title": "Quazar — проверка уведомлений", "body": "Если вы видите это уведомление, всё работает."},
            "data": {"kind": "test"},
            "android": {"priority": "high", "ttl": "300s", "notification": {
                "channel_id": CHANNEL_GENERAL, "tag": "quazar-app-push-test", "default_sound": True,
                "notification_priority": "PRIORITY_HIGH"}},
        }
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


@dataclass(frozen=True)
class Outcome:
    """Чем кончилась отправка на одно устройство. reason — по-русски, для проверки в настройках."""

    ok: bool
    status: int | None = None
    reason: str | None = None
    # Firebase говорит, что приложения на этом телефоне больше нет — адрес можно забыть.
    stale: bool = False


def _error_of(response: httpx.Response) -> tuple[str, set[str], str]:
    try:
        error = response.json().get("error", {})
    except ValueError:
        return "", set(), response.text[:200]
    if not isinstance(error, dict):
        return "", set(), str(error)[:200]
    details = error.get("details") or []
    codes = {d.get("errorCode") for d in details if isinstance(d, dict) and d.get("errorCode")}
    return str(error.get("status") or ""), codes, str(error.get("message") or "")[:200]


def _outcome(response: httpx.Response) -> Outcome:
    if response.status_code == 200:
        return Outcome(ok=True, status=200)
    status, codes, message = _error_of(response)
    code = response.status_code
    if code == 404 or "UNREGISTERED" in codes:
        return Outcome(False, code, "Firebase больше не знает этот телефон: приложение удалили или переустановили", stale=True)
    if "SENDER_ID_MISMATCH" in codes:
        # Ключ сервера от другого проекта Firebase, чем приложение. Телефон тут ни при чём — адрес не удаляем.
        return Outcome(False, code, "Ключ сервера от другого проекта Firebase, чем приложение (SENDER_ID_MISMATCH)")
    if code == 401:
        return Outcome(False, code, "Google не принял токен доступа сервера")
    if code == 403:
        return Outcome(False, code, f"У ключа сервера нет прав на отправку уведомлений ({status or 'PERMISSION_DENIED'}): {message}")
    if code == 400:
        return Outcome(False, code, f"Firebase отклонил уведомление ({status or 'INVALID_ARGUMENT'}): {message}")
    if code in (429, 500, 502, 503, 504):
        return Outcome(False, code, f"Firebase временно недоступен ({code}) — попробуйте позже")
    return Outcome(False, code, f"Firebase ответил {code}: {status} {message}".strip())


def _stale(response: httpx.Response) -> bool:
    """Адрес устройства больше не действует: приложение удалили или переустановили."""
    return _outcome(response).stale


async def deliver(tokens: list[str], payload: dict[str, Any]) -> list[Outcome]:
    """Отправить уведомление на устройства; исход — по каждому, в том же порядке."""
    global _token
    acc = account()
    message = message_for(payload)
    if not tokens:
        return []
    if not acc:
        return [Outcome(False, None, "На сервере нет ключа Firebase") for _ in tokens]
    if not message:
        return [Outcome(False, None, "Это уведомление в приложение не отправляется") for _ in tokens]
    async with _client() as client:
        try:
            access = await _access_token(client, acc)
        except httpx.HTTPStatusError as exc:
            _, _, detail = _error_of(exc.response)
            try:
                detail = exc.response.json().get("error_description") or detail
            except ValueError:
                pass
            reason = f"Google не принял ключ сервера ({exc.response.status_code}): {detail}"
            logger.warning("fcm auth rejected: %s", reason)
            return [Outcome(False, exc.response.status_code, reason) for _ in tokens]
        except httpx.HTTPError as exc:
            reason = f"Нет связи с Google (oauth2.googleapis.com): {type(exc).__name__}"
            logger.warning("fcm auth failed: %s", reason)
            return [Outcome(False, None, reason) for _ in tokens]
        except Exception as exc:  # noqa: BLE001 — например, ключ не читается
            reason = f"Не удалось подписать запрос ключом сервера: {type(exc).__name__}"
            logger.warning("fcm auth failed: %s", reason)
            return [Outcome(False, None, reason) for _ in tokens]
        url = SEND_URL.format(project=acc.project_id)

        async def one(token: str) -> Outcome:
            global _token
            try:
                response = await client.post(
                    url, json={"message": {**message, "token": token}}, headers={"Authorization": f"Bearer {access}"}
                )
            except httpx.HTTPError as exc:
                reason = f"Нет связи с Firebase (fcm.googleapis.com): {type(exc).__name__}"
                logger.warning("fcm send failed: %s", reason)
                return Outcome(False, None, reason)
            if response.status_code == 401:
                # Токен доступа отозван раньше срока — в следующий раз возьмём новый.
                _token = None
            outcome = _outcome(response)
            if not outcome.ok and not outcome.stale:
                logger.warning("fcm rejected: %s", outcome.reason)
            return outcome

        return list(await asyncio.gather(*(one(t) for t in tokens)))


async def send(tokens: list[str], payload: dict[str, Any]) -> tuple[int, list[str]]:
    """Отправить уведомление на устройства. Возвращает (сколько принял FCM, недействительные адреса)."""
    if not account() or not message_for(payload) or not tokens:
        return 0, []
    outcomes = await deliver(tokens, payload)
    return sum(1 for o in outcomes if o.ok), [t for t, o in zip(tokens, outcomes) if o.stale]

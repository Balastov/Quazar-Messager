"""Боты Звёзд: токены Bot API и доставка событий на events_url бота.

Токен — «qzb.<bot_id>.<secret>»; в базе — только sha256(secret). События — POST JSON с
заголовками X-Quazar-Event и X-Quazar-Signature: sha256=<hex HMAC-SHA256(signing_secret, тело)>.
Адрес проверяем, как при превью ссылок: только http(s), только публичные IP, без переадресаций
(иначе бот мог бы заставить сервер стучаться во внутреннюю сеть).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core.link_preview import Blocked, _assert_public, _check_url

log = logging.getLogger(__name__)

TOKEN_PREFIX = "qzb"
TIMEOUT = 5.0
MAX_RESPONSE = 64 * 1024

# Подменяются в тестах.
transport: httpx.AsyncBaseTransport | None = None
session_factory = None  # по умолчанию — app.core.database.AsyncSessionLocal


def new_token(bot_id: str) -> tuple[str, str]:
    """(токен для человека — показать один раз, хэш для базы)."""
    secret = secrets.token_urlsafe(32)
    return f"{TOKEN_PREFIX}.{bot_id}.{secret}", hash_secret(secret)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def parse_token(token: str) -> tuple[str, str] | None:
    """(bot_id, secret) или None, если это не токен бота."""
    parts = token.strip().split(".")
    if len(parts) != 3 or parts[0] != TOKEN_PREFIX or not parts[1] or not parts[2] or len(parts[1]) > 36:
        return None
    return parts[1], parts[2]


def token_matches(secret: str, token_hash: str) -> bool:
    return hmac.compare_digest(hash_secret(secret), token_hash)


def sign(signing_secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(signing_secret.encode(), body, hashlib.sha256).hexdigest()


async def check_events_url(url: str) -> None:
    """Адрес событий — публичный http(s). Иначе Blocked с понятной причиной."""
    await _assert_public(_check_url(url))


class DeliveryError(Exception):
    """Бот не принял событие: недоступен, ответил ошибкой или адрес запрещён."""


async def deliver(url: str, signing_secret: str, event: dict[str, Any]) -> dict[str, Any] | None:
    """Отправить событие боту. Ответ JSON-объектом — вернуть (им бот может обновить сообщение)."""
    body = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()
    try:
        await check_events_url(url)
    except Blocked as exc:
        raise DeliveryError(str(exc)) from None
    headers = {
        "content-type": "application/json",
        "user-agent": "Quazar-Bots/1.0",
        "x-quazar-event": str(event.get("type", "")),
        "x-quazar-signature": sign(signing_secret, body),
        "x-quazar-delivery": secrets.token_hex(8),
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False, transport=transport) as client:
            resp = await client.post(url, content=body, headers=headers)
    except httpx.HTTPError as exc:
        raise DeliveryError(f"Бот не ответил: {type(exc).__name__}") from None
    if resp.is_redirect:
        raise DeliveryError("Бот ответил переадресацией — укажите конечный адрес")
    if resp.status_code >= 400:
        raise DeliveryError(f"Бот ответил {resp.status_code}")
    if "json" not in resp.headers.get("content-type", "") or not resp.content or len(resp.content) > MAX_RESPONSE:
        return None
    try:
        data = json.loads(resp.content)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def message_event(bot_id: str, message: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "message",
        "bot_id": bot_id,
        "star_id": message.get("star_id"),
        "channel_id": message.get("channel_id"),
        "message": message,
        "sent_at": datetime.now(timezone.utc).isoformat(),
    }


async def _deliver_in_background(bot_id: str, url: str, signing_secret: str, event: dict[str, Any]) -> None:
    from sqlalchemy import update

    from app.core.database import AsyncSessionLocal
    from app.models.star import StarBot

    factory = session_factory or AsyncSessionLocal

    error: str | None = None
    try:
        await deliver(url, signing_secret, event)
    except DeliveryError as exc:
        error = str(exc)[:200]
    except Exception:  # noqa: BLE001 — сбой доставки не должен ронять фоновые задачи
        log.exception("bot event delivery failed")
        error = "Внутренняя ошибка доставки"
    try:
        async with factory() as db:
            await db.execute(
                update(StarBot)
                .where(StarBot.id == bot_id)
                .values(last_error=error, last_used_at=datetime.now(timezone.utc))
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        log.warning("bot %s: could not store delivery status", bot_id)


def dispatch_later(targets: list[tuple[str, str, str]], message: dict[str, Any]) -> None:
    """Новое сообщение — ботам Звезды с events_url, в фоне: (bot_id, url, signing_secret)."""
    if not targets:
        return
    loop = asyncio.get_running_loop()
    for bot_id, url, signing_secret in targets:
        loop.create_task(_deliver_in_background(bot_id, url, signing_secret, message_event(bot_id, message)))

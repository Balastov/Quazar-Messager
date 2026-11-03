"""Web Push helpers (VAPID). No-op when keys are not configured."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.push import PushSubscription

logger = logging.getLogger(__name__)
_push_loop = None
_push_slots = None
_urgent_slots = None


def _slots(urgent=False):
    global _push_loop, _push_slots, _urgent_slots
    loop = asyncio.get_running_loop()
    if _push_loop is not loop:
        _push_loop, _push_slots = loop, asyncio.Semaphore(8)
        _urgent_slots = asyncio.Semaphore(2)
    return _urgent_slots if urgent else _push_slots


def push_configured() -> bool:
    return bool(settings.VAPID_PUBLIC_KEY.strip() and settings.VAPID_PRIVATE_KEY.strip())


async def user_has_push(user_id: str) -> bool:
    if not push_configured():
        return False
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(PushSubscription.id).where(PushSubscription.user_id == user_id, PushSubscription.enabled.is_(True)).limit(1)
        )
        return result.scalar_one_or_none() is not None


async def send_push_to_user(user_id: str, payload: dict[str, Any]) -> int:
    """Send JSON payload to all subscriptions of user. Returns number of successes."""
    if not push_configured():
        return 0

    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.warning("pywebpush not installed — skip push")
        return 0

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(PushSubscription).where(PushSubscription.user_id == user_id)
        )
        subs = list(result.scalars().all())

    if not subs:
        return 0

    default_ttl = settings.CALL_RING_TIMEOUT_SEC if payload.get("type") == "incoming_call" else 300 if payload.get("type") == "star_door" else 86400
    ttl = max(1, min(86400, int(payload.get("ttl", default_ttl))))

    async def send(sub):
        async with _slots(payload.get("type") == "incoming_call"):
            async with AsyncSessionLocal() as db:
                current = (await db.execute(select(PushSubscription).where(PushSubscription.id == sub.id,
                    PushSubscription.user_id == user_id))).scalar_one_or_none()
            if not current or not current.enabled or (payload.get("message_id") and payload["message_id"] in (current.recent_message_ids or [])):
                return False, None
            subscription_info = {"endpoint": current.endpoint, "keys": {"p256dh": current.p256dh, "auth": current.auth}}
            body = json.dumps({**payload, "recipient_user_id": user_id,
                "silent": not current.sound if payload.get("type") in ("chat_message", "star_message") else False}, ensure_ascii=False)
            try:
                # Синхронный HTTP SDK не должен останавливать WebSocket и обработку сообщений.
                # SDK изменяет claims: отдельный словарь нужен для каждого push-провайдера.
                await asyncio.to_thread(webpush, subscription_info=subscription_info, data=body,
                    vapid_private_key=settings.VAPID_PRIVATE_KEY, vapid_claims={"sub": settings.VAPID_SUBJECT},
                    ttl=ttl, timeout=10)
                return True, None
            except WebPushException as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                logger.info("push rejected (status=%s)", status)
                return False, sub.id if status in (404, 410) else None
            except Exception:
                logger.warning("push transport error")
                return False, None

    results = await asyncio.gather(*(send(sub) for sub in subs))
    ok = sum(1 for success, _ in results if success)
    stale = [sub_id for _, sub_id in results if sub_id]

    if stale:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(PushSubscription).where(PushSubscription.id.in_(stale))
            )
            for row in result.scalars().all():
                await db.delete(row)
            await db.commit()

    return ok

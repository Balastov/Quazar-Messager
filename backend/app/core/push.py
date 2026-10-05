"""Web Push helpers (VAPID). No-op when keys are not configured."""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.push import PushSubscription

logger = logging.getLogger(__name__)


def push_configured() -> bool:
    return bool(settings.VAPID_PUBLIC_KEY.strip() and settings.VAPID_PRIVATE_KEY.strip())


async def user_has_push(user_id: str) -> bool:
    if not push_configured():
        return False
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(PushSubscription.id).where(PushSubscription.user_id == user_id).limit(1)
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

    body = json.dumps(payload, ensure_ascii=False)
    vapid_claims = {"sub": settings.VAPID_SUBJECT}
    ok = 0
    stale: list[str] = []

    for sub in subs:
        subscription_info = {
            "endpoint": sub.endpoint,
            "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=body,
                vapid_private_key=settings.VAPID_PRIVATE_KEY,
                vapid_claims=vapid_claims,
            )
            ok += 1
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            logger.info("push failed for %s: %s", sub.endpoint[:48], exc)
            if status in (404, 410):
                stale.append(sub.id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("push error: %s", exc)

    if stale:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(PushSubscription).where(PushSubscription.id.in_(stale))
            )
            for row in result.scalars().all():
                await db.delete(row)
            await db.commit()

    return ok

"""Send a single explicitly requested probe to its initiating device only."""
import asyncio
import hashlib
import json
from datetime import datetime, timezone
from urllib.parse import urlsplit
from sqlalchemy import delete, update
from app.core import device_sessions
from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.link_preview import _assert_public
from app.core.push import _slots
from app.models.connection_check import ConnectionCheck
from app.models.device import DeviceSession
from app.models.push import PushSubscription
from app.models.user import User
from app.ws.hub import manager

DELAY_SECONDS = 3
PROVIDERS = ("fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com", "wns.windows.com")
def now(): return datetime.now(timezone.utc)
def digest(value): return hashlib.sha256(value.encode()).hexdigest()
def allowed_endpoint(value: str) -> bool:
    try:
        url = urlsplit(value)
        return (url.scheme == "https" and not url.username and not url.password and not url.fragment and
                url.port in (None, 443) and any(url.hostname == domain or (url.hostname or "").endswith("." + domain) for domain in PROVIDERS))
    except ValueError: return False

async def send_probe(subscription: PushSubscription, payload: dict) -> str | None:
    if not allowed_endpoint(subscription.endpoint): return "unsupported_provider"
    if not settings.VAPID_PUBLIC_KEY.strip() or not settings.VAPID_PRIVATE_KEY.strip(): return "not_configured"
    try:
        from pywebpush import webpush, WebPushException
        import requests
    except ImportError:
        return "not_configured"
    try:
        await _assert_public(urlsplit(subscription.endpoint).hostname)
        class NoRedirects(requests.Session):
            def post(self, url, *args, **kwargs):
                kwargs["allow_redirects"] = False
                return super().post(url, *args, **kwargs)
        def deliver():
            with NoRedirects() as transport:
                transport.trust_env = False
                response = webpush(subscription_info={"endpoint": subscription.endpoint, "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth}},
                    data=json.dumps(payload, ensure_ascii=False), vapid_private_key=settings.VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": settings.VAPID_SUBJECT}, ttl=60, timeout=10, requests_session=transport)
                if not 200 <= response.status_code < 300: return "transport_error"
                return None
        async with _slots():
            return await asyncio.to_thread(deliver)
    except WebPushException as error:
        status = getattr(getattr(error, "response", None), "status_code", None)
        return "subscription_expired" if status in (404, 410) else "transport_error"
    except Exception:
        return "transport_error"

async def deliver(check_id: str, secret: str) -> None:
    await asyncio.sleep(DELAY_SECONDS)
    async with AsyncSessionLocal() as db:
        check = await db.get(ConnectionCheck, check_id)
        if not check or check.expires_at <= now(): return
        user = await db.get(User, check.user_id)
        session = await db.get(DeviceSession, check.session_id) if check.session_id else None
        if (not user or user.blocked_at or not session or session.revoked_at or session.expires_at <= now() or
            (device_sessions.cutoff(user) and session.issued_at < device_sessions.cutoff(user))): return
        payload = {"type": "connection_test", "test_id": check.id, "receipt_secret": secret,
            "title": "Quazar — проверка связи", "body": "Тестовое уведомление доставлено с сервера на это устройство.", "recipient_user_id": user.id}
        sub = await db.get(PushSubscription, check.subscription_id) if check.transport == "push" and check.subscription_id else None
        # Do not hold a database connection while the push provider or WebSocket replies.
        await db.commit()
        if check.transport == "push":
            error = "subscription_missing" if not sub or sub.user_id != user.id or not sub.enabled else await send_probe(sub, payload)
        else:
            targets = [ws for ws in manager.user_connections.get(user.id, []) if getattr(ws, "_quazar_session_id", None) == session.id]
            sent = False
            for ws in targets:
                try: await ws.send_text(json.dumps(payload)); sent = True
                except Exception: pass
            error = None if sent else "desktop_offline"
        await db.execute(update(ConnectionCheck).where(ConnectionCheck.id == check.id, ConnectionCheck.state != "displayed")
            .values(state="failed" if error else "sent", error_code=error))
        if error == "subscription_expired" and sub:
            await db.execute(delete(PushSubscription).where(PushSubscription.id == sub.id, PushSubscription.user_id == user.id))
        await db.commit()

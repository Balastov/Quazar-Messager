"""Зелёный колокольчик: уведомления, которые не теряются (брони и их изменения).

Каждое уведомление хранится у человека, пока не прочитано; открыли — прочитано на всех устройствах.
Рассылка: inbox_new — новое уведомление и сколько непрочитанных; inbox_read — что прочитано;
inbox_removed — какие убрала очистка (старше KEEP_DAYS календарных дней).
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Iterable
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inbox import InboxNotification
from app.ws.hub import manager

# Уведомления хранятся KEEP_DAYS календарных дней по Москве — прочитанные и нет: пришедшее 16-го
# видно по 26-е включительно и пропадает 27-го. Чистит планировщик раз в час.
KEEP_DAYS = 10
MOSCOW = ZoneInfo("Europe/Moscow")
CLEANUP_EVERY_SEC = 3600
_last_cleanup = 0.0


def out(n: InboxNotification) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "title": n.title,
        "body": n.body,
        "data": n.data or {},
        "created_at": n.created_at.isoformat(),
        "read_at": n.read_at.isoformat() if n.read_at else None,
    }


async def unread_count(db: AsyncSession, user_id: str) -> int:
    return (
        await db.execute(
            select(func.count()).select_from(InboxNotification).where(
                InboxNotification.user_id == user_id, InboxNotification.read_at.is_(None)
            )
        )
    ).scalar_one()


async def notify(
    db: AsyncSession, user_ids: Iterable[str | None], kind: str, title: str, body: str, data: dict
) -> list[InboxNotification]:
    """Положить уведомление в колокольчик каждому и сразу показать на открытых устройствах."""
    now = datetime.now(timezone.utc)
    rows = [
        InboxNotification(user_id=uid, kind=kind, title=title[:200], body=body, data=data, created_at=now)
        for uid in dict.fromkeys(u for u in user_ids if u)
    ]
    if not rows:
        return []
    db.add_all(rows)
    await db.commit()
    for row in rows:
        await manager.send_to_user(
            row.user_id,
            {"type": "inbox_new", "notification": out(row), "unread": await unread_count(db, row.user_id)},
        )
    return rows


def cutoff(now: datetime | None = None) -> datetime:
    """Начало дня по Москве KEEP_DAYS дней назад: всё, что пришло раньше, — старше 10 календарных дней."""
    today = (now or datetime.now(timezone.utc)).astimezone(MOSCOW).date()
    start = datetime.combine(today - timedelta(days=KEEP_DAYS), datetime.min.time(), tzinfo=MOSCOW)
    return start.astimezone(timezone.utc)


async def cleanup(db: AsyncSession, *, force: bool = False) -> int:
    """Убрать уведомления старше KEEP_DAYS календарных дней и сказать открытым устройствам, что пропало."""
    global _last_cleanup
    if not force and time.monotonic() - _last_cleanup < CLEANUP_EVERY_SEC:
        return 0
    _last_cleanup = time.monotonic()
    removed = (await db.execute(
        delete(InboxNotification).where(InboxNotification.created_at < cutoff())
        .returning(InboxNotification.id, InboxNotification.user_id)
    )).all()
    await db.commit()
    by_user: dict[str, list[str]] = {}
    for notification_id, user_id in removed:
        by_user.setdefault(user_id, []).append(notification_id)
    for user_id, ids in by_user.items():
        if manager.user_connections.get(user_id):
            await manager.send_to_user(user_id, {"type": "inbox_removed", "ids": ids, "unread": await unread_count(db, user_id)})
    return len(removed)


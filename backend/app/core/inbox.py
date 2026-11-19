"""Зелёный колокольчик: уведомления, которые не теряются (брони и их изменения).

Каждое уведомление хранится у человека, пока не прочитано; открыли — прочитано на всех устройствах.
Рассылка: inbox_new — новое уведомление и сколько непрочитанных; inbox_read — что прочитано.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inbox import InboxNotification
from app.ws.hub import manager

# Прочитанные старше этого убираем, чтобы список не рос бесконечно.
KEEP_READ = timedelta(days=90)


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
    await db.execute(
        delete(InboxNotification).where(
            InboxNotification.user_id.in_([r.user_id for r in rows]),
            InboxNotification.read_at.is_not(None),
            InboxNotification.created_at < now - KEEP_READ,
        )
    )
    await db.commit()
    for row in rows:
        await manager.send_to_user(
            row.user_id,
            {"type": "inbox_new", "notification": out(row), "unread": await unread_count(db, row.user_id)},
        )
    return rows

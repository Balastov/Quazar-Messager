"""Фоновые дела раз в несколько секунд: отложенные сообщения, напоминания, исчезающие сообщения,
сборы групп по времени, уборка опустевших временных Планет.

Строки берутся с FOR UPDATE SKIP LOCKED — несколько процессов бэкенда не сделают одно дело дважды.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.chat import Chat
from app.models.message import Message, MessageReminder, ScheduledMessage
from app.models.star import ScheduledStarMessage
from app.models.user import User

log = logging.getLogger(__name__)

TICK_SEC = 5
BATCH = 100


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def send_due_scheduled(db: AsyncSession, now: datetime | None = None) -> int:
    """Отложенные, чьё время пришло, → обычные сообщения. Возвращает, сколько отправлено."""
    from app.api.later import scheduled_changed
    from app.api.messages import deliver

    cutoff = now or _now()
    sent = 0
    for _ in range(BATCH):
        # deliver коммитит: блокируем по одной строке, чтобы следующий процесс не
        # забрал остаток заранее выбранной пачки после первого коммита.
        item = (
            await db.execute(
                select(ScheduledMessage)
                .where(ScheduledMessage.send_at <= cutoff)
                .order_by(ScheduledMessage.send_at, ScheduledMessage.id)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
        ).scalar_one_or_none()
        if item is None:
            break
        chat = (await db.execute(select(Chat).where(Chat.id == item.chat_id))).scalar_one_or_none()
        reply_to = None
        if item.reply_to_id:
            reply_to = (
                await db.execute(select(Message).where(Message.id == item.reply_to_id))
            ).scalar_one_or_none()
        sender_id, chat_id, payload = item.sender_id, item.chat_id, item.payload
        await db.delete(item)
        await db.flush()
        if not chat:
            await db.commit()
            continue
        try:
            # deliver коммитит — заодно фиксирует удаление из очереди.
            await deliver(db, chat, sender_id, payload, reply_to=reply_to)
            sent += 1
        except HTTPException as exc:
            # Например, отправитель с тех пор заблокировал собеседника — не отправляем.
            log.info("scheduled message dropped: %s", exc.detail)
            await db.commit()
        await scheduled_changed(sender_id, chat_id)
    return sent


async def send_due_star_scheduled(db: AsyncSession, now: datetime | None = None) -> int:
    from app.api.star_later import scheduled_changed
    from app.api.stars import send_message
    from app.schemas.star import SendStarMessage

    cutoff = now or _now()
    sent = 0
    for _ in range(BATCH):
        item = (
            await db.execute(
                select(ScheduledStarMessage)
                .where(ScheduledStarMessage.send_at <= cutoff)
                .order_by(ScheduledStarMessage.send_at, ScheduledStarMessage.id)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
        ).scalar_one_or_none()
        if item is None:
            break
        item_id, sender_id, star_id, channel_id = item.id, item.sender_id, item.star_id, item.channel_id
        body = SendStarMessage(
            text=item.text,
            reply_to_id=item.reply_to_id,
            ack_required=item.ack_required,
            link_preview=item.link_preview,
        )
        sender = await db.get(User, sender_id)
        # Удаление очереди и создание сообщения фиксируются одним коммитом в send_message.
        await db.delete(item)
        await db.flush()
        error = None
        try:
            if sender is None:
                await db.commit()
                continue
            await send_message(star_id, channel_id, body, sender, db)
            sent += 1
        except HTTPException as exc:
            if exc.status_code == 429:
                # Медленный режим: сохраняем сообщение до следующей попытки.
                await db.rollback()
                await db.execute(
                    update(ScheduledStarMessage)
                    .where(ScheduledStarMessage.id == item_id)
                    .values(send_at=max(cutoff, _now()) + timedelta(seconds=TICK_SEC))
                )
            else:
                # Вышел из Звезды, заблокирован, изменились права или фильтр слов.
                error = str(exc.detail)
                log.info("scheduled satellite message dropped: %s", error)
            await db.commit()
        await scheduled_changed(sender_id, star_id, channel_id, error)
    return sent


async def fire_due_reminders(db: AsyncSession, now: datetime | None = None) -> int:
    from app.core.push import send_push_to_user
    from app.ws.hub import manager

    rows = (
        await db.execute(
            select(MessageReminder)
            .where(MessageReminder.remind_at <= (now or _now()))
            .limit(BATCH)
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    due = [(r.id, r.user_id, r.chat_id, r.message_id) for r in rows]
    if not due:
        return 0
    await db.execute(delete(MessageReminder).where(MessageReminder.id.in_([d[0] for d in due])))
    await db.commit()
    for reminder_id, user_id, chat_id, message_id in due:
        await manager.send_to_user(
            user_id,
            {"type": "reminder", "reminder_id": reminder_id, "chat_id": chat_id, "message_id": message_id},
        )
        # Текст сообщения сервер не знает (E2E) — в push только сам факт.
        await send_push_to_user(
            user_id,
            {
                "title": "Напоминание",
                "body": "Вы просили напомнить о сообщении",
                "tag": f"quazar-reminder-{reminder_id}",
                "chat_id": chat_id,
            },
        )
    return len(due)


async def expire_messages(db: AsyncSession, now: datetime | None = None) -> int:
    """Исчезающие сообщения, чьё время вышло, — удалить у всех (с картинками и голосовыми)."""
    from app.api.messages import purge

    rows = (
        await db.execute(
            select(Message.id, Message.chat_id)
            .where(Message.expires_at.is_not(None), Message.expires_at <= (now or _now()))
            .limit(BATCH * 5)
            .with_for_update(skip_locked=True)
        )
    ).all()
    by_chat: dict[str, list[str]] = {}
    for message_id, chat_id in rows:
        by_chat.setdefault(chat_id, []).append(message_id)
    for chat_id, ids in by_chat.items():
        await purge(db, chat_id, ids)
    return len(rows)


async def start_due_lfg(db: AsyncSession, now: datetime | None = None) -> int:
    from app.api.star_play import start_due_lfg as start

    return await start(db, now)


async def sweep_temporary_planets(db: AsyncSession, now: datetime | None = None) -> int:
    from app.api.star_play import sweep_temporary_planets as sweep

    return await sweep(db, now)


async def booking_tick(db: AsyncSession, now: datetime | None = None) -> int:
    from app.api.star_work import booking_tick as tick

    return await tick(db, now)


async def run_due_workflows(db: AsyncSession, now: datetime | None = None) -> int:
    from app.core import workflows

    return await workflows.run_due(db, now)


async def run_forever(session_factory: async_sessionmaker) -> None:
    while True:
        for job in (
            send_due_scheduled,
            send_due_star_scheduled,
            fire_due_reminders,
            expire_messages,
            start_due_lfg,
            sweep_temporary_planets,
            booking_tick,
            run_due_workflows,
        ):
            try:
                async with session_factory() as db:
                    await job(db)
            except Exception:  # noqa: BLE001 — фоновая задача не должна падать насовсем
                log.exception("scheduler job %s failed", job.__name__)
        await asyncio.sleep(TICK_SEC)

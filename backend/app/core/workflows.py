"""Сценарии Звёзд (простой Workflow Builder): когда сработать и что написать.

Публикация — сообщением kind="bot" с bot_kind="workflow" и именем сценария, как у интеграций:
с упоминаниями, push и событиями для ботов Звезды.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import stars as rules
from app.models.star import Star, StarChannel, StarMember, StarMessage, StarWorkflow
from app.models.user import User

DEFAULT_TZ = "Europe/Moscow"
_VAR = re.compile(r"\{([a-z0-9_]{1,32})\}")


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TZ)


def next_run(schedule: dict, after: datetime) -> datetime | None:
    """Ближайший момент после after: дни недели (пн = 1) и «ЧЧ:ММ» в часовом поясе расписания."""
    days = {int(d) for d in schedule.get("days") or []}
    if not days:
        return None
    hour, minute = (int(x) for x in str(schedule.get("time", "10:00")).split(":"))
    tz = zone(schedule.get("tz"))
    local = after.astimezone(tz)
    for shift in range(8):
        day = (local + timedelta(days=shift)).date()
        if day.isoweekday() not in days:
            continue
        candidate = datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)
        if candidate > local:
            return candidate.astimezone(timezone.utc)
    return None


def render(template: str, values: dict[str, str]) -> str:
    """{переменная} → значение; неизвестные остаются как написаны."""
    return _VAR.sub(lambda m: values.get(m.group(1), m.group(0)), template)


def base_values(star: Star, tz: str | None, user: User | None = None) -> dict[str, str]:
    values = {"star": star.name, "date": datetime.now(zone(tz)).strftime("%d.%m.%Y")}
    if user:
        values["user"] = f"@{user.username}"
        values["name"] = user.display_name
    return values


async def post(
    db: AsyncSession, workflow: StarWorkflow, text: str, not_mention: str | None = None
) -> StarMessage | None:
    """Написать от имени сценария в его Спутник (канал удалили или не Спутник — молча ничего).

    not_mention — кого не считать упомянутым (автор формы: «от @он» — подпись, а не зов)."""
    from app.api.stars import _broadcast, _messages_out, bot_targets
    from app.core import bots, markup, notify

    channel = await db.get(StarChannel, workflow.channel_id)
    star = await db.get(Star, workflow.star_id)
    if not channel or not star or channel.kind != "satellite" or channel.star_id != star.id:
        return None
    text = text.strip()[: rules.MAX_MESSAGE_LENGTH]
    if not text:
        return None
    names = dict(
        (
            await db.execute(
                select(func.lower(User.username), User.id)
                .join(StarMember, StarMember.user_id == User.id)
                .where(StarMember.star_id == star.id)
            )
        ).all()
    )
    message = StarMessage(
        star_id=star.id,
        channel_id=channel.id,
        sender_id=None,
        text=text,
        kind="bot",
        bot_name=workflow.name,
        bot_kind="workflow",
        # Упоминания людей — да, @все — нет: сценарий не модератор.
        mentions=sorted(notify.find_mentions(text, names).ids - {not_mention}),
    )
    db.add(message)
    workflow.last_run_at = datetime.now(timezone.utc)
    await db.commit()
    out = (await _messages_out(db, [(message, None)]))[0]
    await _broadcast(db, star.id, {"type": "star_message", "message": out.model_dump(mode="json")})
    targets = await notify.star_push_targets(db, star, channel, message)
    notify.push_later(
        targets,
        {
            "type": "star_message",
            "title": f"{workflow.name} · #{channel.name} · {star.name}",
            "body": markup.plain_text(text)[:200],
            "star_id": star.id,
            "channel_id": channel.id,
            "message_id": message.id,
            "tag": f"quazar-star-{channel.id}",
        },
    )
    bots.dispatch_later(await bot_targets(db, channel), out.model_dump(mode="json"))
    return message


async def on_member_joined(db: AsyncSession, star: Star, user: User) -> None:
    rows = await db.execute(
        select(StarWorkflow).where(
            StarWorkflow.star_id == star.id, StarWorkflow.enabled.is_(True), StarWorkflow.trigger == "member_joined"
        )
    )
    for workflow in rows.scalars().all():
        await post(db, workflow, render(workflow.text, base_values(star, None, user)))


async def run_due(db: AsyncSession, now: datetime | None = None) -> int:
    """Сценарии по расписанию, чьё время пришло. Пропущенное (сервер лежал) — один раз, не пачкой."""
    now = now or datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(StarWorkflow)
            .where(
                StarWorkflow.trigger == "schedule",
                StarWorkflow.enabled.is_(True),
                StarWorkflow.next_run_at.is_not(None),
                StarWorkflow.next_run_at <= now,
            )
            .limit(50)
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    due = [(w.id, w.star_id, dict(w.schedule or {}), w.text) for w in rows]
    for workflow in rows:
        workflow.next_run_at = next_run(workflow.schedule or {}, now)
    await db.commit()
    for workflow_id, star_id, schedule, text in due:
        workflow = await db.get(StarWorkflow, workflow_id)
        star = await db.get(Star, star_id)
        if workflow and star:
            await post(db, workflow, render(text, base_values(star, schedule.get("tz"))))
    return len(due)

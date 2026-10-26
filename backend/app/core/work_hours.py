"""Рабочее время: общий график Звезды и личный график участника поверх него.

График — {"days": [1..7] (пн = 1), "start": "09:00", "end": "18:00", "tz": "Europe/Moscow"}.
end раньше start — смена через полночь (22:00–06:00). Тот же расчёт — web/src/chat/workhours.ts.
"""

from __future__ import annotations

import re
from datetime import datetime, time, timezone
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select

from app.models.user import User

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.star import Star

DEFAULT_SCHEDULE = {"days": [1, 2, 3, 4, 5], "start": "09:00", "end": "18:00", "tz": "Europe/Moscow"}
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def normalize(raw: dict | None) -> dict:
    """Проверить и привести к виду графика. Ошибка — ValueError с текстом для человека."""
    if not isinstance(raw, dict):
        raise ValueError("Нужен график")
    days = raw.get("days")
    if not isinstance(days, list) or not days or any(not isinstance(d, int) or not 1 <= d <= 7 for d in days):
        raise ValueError("Рабочие дни — числа от 1 (пн) до 7 (вс)")
    start, end = raw.get("start"), raw.get("end")
    if not isinstance(start, str) or not _HHMM.match(start) or not isinstance(end, str) or not _HHMM.match(end):
        raise ValueError("Время — в виде ЧЧ:ММ")
    if start == end:
        raise ValueError("Начало и конец совпадают")
    tz = raw.get("tz")
    try:
        ZoneInfo(tz)  # type: ignore[arg-type]
    except (ZoneInfoNotFoundError, TypeError, ValueError):
        raise ValueError("Неизвестный часовой пояс") from None
    return {"days": sorted(set(days)), "start": start, "end": end, "tz": tz}


def effective(star_schedule: dict | None, personal: dict | None) -> dict:
    """Личный график, если задан, иначе общий график Звезды."""
    return personal or star_schedule or DEFAULT_SCHEDULE


def is_working(schedule: dict, now: datetime) -> bool:
    local = now.astimezone(ZoneInfo(schedule["tz"]))
    start = time.fromisoformat(schedule["start"])
    end = time.fromisoformat(schedule["end"])
    t = local.time()
    day = local.isoweekday()
    if start < end:
        return day in schedule["days"] and start <= t < end
    # Через полночь: вечер — в рабочий день, утро — продолжение вчерашней смены.
    if t >= start:
        return day in schedule["days"]
    yesterday = 7 if day == 1 else day - 1
    return t < end and yesterday in schedule["days"]


async def resting(db: AsyncSession, star: Star, user_ids: list[str], now: datetime | None = None) -> set[str]:
    """Кто из них сейчас вне своего рабочего времени (если в Звезде оно включено)."""
    if not star.work_hours_enabled or not user_ids:
        return set()
    now = now or datetime.now(timezone.utc)
    rows = (await db.execute(select(User.id, User.work_schedule).where(User.id.in_(user_ids)))).all()
    return {uid for uid, own in rows if not is_working(effective(star.work_hours, own), now)}

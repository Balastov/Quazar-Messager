"""Повтор брони — как в календаре: каждый день, по будням, по дням недели, раз в месяц.

Правило (StarBookingSeries.rule):
    freq      daily | weekly | monthly
    interval  каждые N дней / недель / месяцев
    weekdays  для weekly: дни недели, 0 — понедельник … 6 — воскресенье
    monthly   для monthly: day — того же числа; weekday — в тот же N-й день недели
              («во второй вторник»); last_weekday — в последний такой день недели месяца
    until     «ГГГГ-ММ-ДД» — последний день (включительно) или null
    count     сколько встреч всего (вместе с первой) или null; until и count вместе не бывают

Встречи считаются в «настенном» времени часового пояса серии: 10:00 остаётся 10:00 и после
перехода на летнее время. Первая встреча — всегда та, что выбрали, даже если её день не входит
в правило (как DTSTART в iCalendar).
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta
from typing import Iterator
from zoneinfo import ZoneInfo

FREQS = ("daily", "weekly", "monthly")
MONTHLY = ("day", "weekday", "last_weekday")
MAX_INTERVAL = 30
MAX_COUNT = 365
# Дальше не заглядываем ни при каком правиле: защита от бесконечного перебора.
HORIZON_YEARS = 5


def normalize(rule: dict, first: date) -> dict:
    """Проверяет правило и приводит к виду для хранения. ValueError — с понятной причиной."""
    freq = rule.get("freq")
    if freq not in FREQS:
        raise ValueError("Непонятный повтор")
    interval = int(rule.get("interval") or 1)
    if not 1 <= interval <= MAX_INTERVAL:
        raise ValueError(f"Повторять можно не реже, чем раз в {MAX_INTERVAL}")
    out: dict = {"freq": freq, "interval": interval}
    if freq == "weekly":
        days = sorted({int(d) for d in rule.get("weekdays") or [first.weekday()]})
        if not days or any(d < 0 or d > 6 for d in days):
            raise ValueError("Выберите дни недели")
        out["weekdays"] = days
    if freq == "monthly":
        monthly = rule.get("monthly") or "day"
        if monthly not in MONTHLY:
            raise ValueError("Непонятный повтор по месяцам")
        if monthly == "last_weekday" and (first + timedelta(days=7)).month == first.month:
            raise ValueError("Этот день — не последний такой в месяце")
        out["monthly"] = monthly
    until, count = rule.get("until"), rule.get("count")
    if until and count:
        raise ValueError("Укажите что-то одно: дату окончания или число встреч")
    if until:
        until_date = until if isinstance(until, date) else date.fromisoformat(str(until))
        if until_date < first:
            raise ValueError("Повтор заканчивается раньше первой встречи")
        out["until"] = until_date.isoformat()
    if count:
        count = int(count)
        if not 2 <= count <= MAX_COUNT:
            raise ValueError(f"Встреч в серии — от 2 до {MAX_COUNT}")
        out["count"] = count
    return out


def _add_months(year: int, month: int, months: int) -> tuple[int, int]:
    index = year * 12 + month - 1 + months
    return index // 12, index % 12 + 1


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date | None:
    """nth-й (1…5) такой день недели месяца, -1 — последний; None, если его нет."""
    days = calendar.monthrange(year, month)[1]
    if nth == -1:
        last = date(year, month, days)
        return last - timedelta(days=(last.weekday() - weekday) % 7)
    first = date(year, month, 1)
    day = 1 + (weekday - first.weekday()) % 7 + 7 * (nth - 1)
    return date(year, month, day) if day <= days else None


def _dates(rule: dict, first: date) -> Iterator[date]:
    """Дни встреч по порядку, начиная с первой (без учёта until/count)."""
    yield first
    freq, interval = rule["freq"], rule["interval"]
    limit = first.replace(year=first.year + HORIZON_YEARS) if not (first.month == 2 and first.day == 29) \
        else date(first.year + HORIZON_YEARS, 3, 1)
    if freq == "daily":
        day = first + timedelta(days=interval)
        while day <= limit:
            yield day
            day += timedelta(days=interval)
    elif freq == "weekly":
        monday = first - timedelta(days=first.weekday())
        while monday <= limit:
            for weekday in rule["weekdays"]:
                day = monday + timedelta(days=weekday)
                if day > first:
                    yield day
            monday += timedelta(weeks=interval)
    else:
        mode = rule.get("monthly", "day")
        nth = -1 if mode == "last_weekday" else (first.day - 1) // 7 + 1
        step = interval
        while True:
            year, month = _add_months(first.year, first.month, step)
            if date(year, month, 1) > limit:
                return
            if mode == "day":
                day = date(year, month, first.day) if first.day <= calendar.monthrange(year, month)[1] else None
            else:
                day = _nth_weekday(year, month, first.weekday(), nth)
            if day:  # 31-го или пятого вторника в этом месяце нет — пропускаем, как календарь
                yield day
            step += interval


def occurrences(rule: dict, first_start: datetime, tz: str) -> Iterator[datetime]:
    """Начала встреч серии (с часовым поясом), первая — first_start."""
    zone = ZoneInfo(tz)
    local = first_start.astimezone(zone)
    wall: time = local.time().replace(tzinfo=None)
    until = date.fromisoformat(rule["until"]) if rule.get("until") else None
    count = rule.get("count")
    for index, day in enumerate(_dates(rule, local.date())):
        if count and index >= count:
            return
        if until and day > until:
            return
        yield datetime.combine(day, wall, tzinfo=zone)


# --- Подпись: «по вторникам и четвергам», «каждый месяц во второй вторник» -------------------

_PLURAL_DAT = ["понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям"]
_ACC = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"]
_GENDER = ["m", "m", "f", "m", "f", "f", "n"]
_ORDINALS = {
    "m": ["первый", "второй", "третий", "четвёртый", "пятый", "последний"],
    "f": ["первую", "вторую", "третью", "четвёртую", "пятую", "последнюю"],
    "n": ["первое", "второе", "третье", "четвёртое", "пятое", "последнее"],
}


def _plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def _join(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " и " + words[-1]


def describe(rule: dict, first: date) -> str:
    """Подпись правила по-русски. Должна совпадать с web/src/components/constellation/repeat.ts."""
    freq, interval = rule["freq"], rule.get("interval", 1)
    if freq == "daily":
        text = "каждый день" if interval == 1 else f"раз в {interval} {_plural(interval, 'день', 'дня', 'дней')}"
    elif freq == "weekly":
        days = rule.get("weekdays") or [first.weekday()]
        if days == [0, 1, 2, 3, 4]:
            on = "по будням"
        elif len(days) == 7:
            on = "каждый день"
        else:
            on = "по " + _join([_PLURAL_DAT[d] for d in days])
        text = on if interval == 1 else f"раз в {interval} {_plural(interval, 'неделю', 'недели', 'недель')}, {on}"
    else:
        every = "каждый месяц" if interval == 1 else f"раз в {interval} {_plural(interval, 'месяц', 'месяца', 'месяцев')}"
        mode = rule.get("monthly", "day")
        if mode == "day":
            text = f"{every}, {first.day}-го числа"
        else:
            weekday = first.weekday()
            index = 5 if mode == "last_weekday" else (first.day - 1) // 7
            ordinal = _ORDINALS[_GENDER[weekday]][index]
            text = f"{every}, {'во' if ordinal.startswith('втор') else 'в'} {ordinal} {_ACC[weekday]}"
    if rule.get("until"):
        until = date.fromisoformat(rule["until"])
        text += f", до {until.strftime('%d.%m.%Y')}"
    elif rule.get("count"):
        count = rule["count"]
        text += f", {count} {_plural(count, 'раз', 'раза', 'раз')}"
    return text

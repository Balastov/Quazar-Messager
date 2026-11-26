"""Рабочие Звёзды: ветки, объявления с «Ознакомлен(а)», рабочее время, брони комнат, табличка на двери."""

import logging
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import (
    _as_star,
    _broadcast,
    _channel,
    _channel_event,
    _chat,
    _forbid,
    _load_membership,
    _messages_out,
    _require_perm,
    _star_message,
    _user_out,
    assert_room_access,
    broadcast_member,
)
from app.core import floors as floors_svc
from app.core import inbox, presence, recurrence, star_audit, work_hours
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.push import send_push_to_user
from app.core.stars import Perm
from app.models.star import Star, StarBooking, StarBookingSeries, StarChannel, StarMember, StarMessage, StarMessageAck
from app.models.user import User
from app.schemas.star import StarMessageOut, StarUserOut
from app.core import pseudonyms
from app.ws.hub import manager

log = logging.getLogger(__name__)

router = APIRouter(prefix="/stars", tags=["stars"])
me_router = APIRouter(prefix="/users", tags=["users"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _local(star: Star | None, at: datetime) -> str:
    """ЧЧ:ММ в часовом поясе Звезды (из её графика; по умолчанию — Москва)."""
    tz = ((star.work_hours if star else None) or work_hours.DEFAULT_SCHEDULE)["tz"]
    return at.astimezone(ZoneInfo(tz)).strftime("%H:%M")


def _span(star: Star | None, start: datetime, end: datetime) -> str:
    """«20.11, 14:00–15:00» в часовом поясе Звезды."""
    tz = ((star.work_hours if star else None) or work_hours.DEFAULT_SCHEDULE)["tz"]
    return f"{start.astimezone(ZoneInfo(tz)).strftime('%d.%m')}, {_local(star, start)}–{_local(star, end)}"


# --- Ветки ---------------------------------------------------------------------


@router.get("/{star_id}/channels/{channel_id}/threads/{root_id}", response_model=list[StarMessageOut])
async def thread_messages(
    star_id: str,
    channel_id: str,
    root_id: str,
    current_user: CurrentUser,
    db: Db,
    limit: int = Query(100, ge=1, le=200),
):
    """Корень ветки и ответы в ней (последние limit), по времени."""
    await _chat(db, star_id, channel_id, current_user.id)
    root = await _star_message(db, star_id, channel_id, root_id)
    rows = (
        await db.execute(
            select(StarMessage, User)
            .outerjoin(User, User.id == StarMessage.sender_id)
            .where(StarMessage.thread_id == root_id)
            .order_by(StarMessage.created_at.desc())
            .limit(limit)
        )
    ).all()
    sender = (await db.execute(select(User).where(User.id == root.sender_id))).scalar_one_or_none()
    return _as_star(await _messages_out(db, [(root, sender), *[(m, u) for m, u in reversed(rows)]], current_user.id, star_id=star_id), star_id)


# --- Объявления: «Ознакомлен(а)» -------------------------------------------------


class AcksOut(BaseModel):
    acked: list[StarUserOut]
    pending: list[StarUserOut]


async def _ack_message(db: AsyncSession, star_id: str, message_id: str) -> StarMessage:
    message = (
        await db.execute(select(StarMessage).where(StarMessage.id == message_id, StarMessage.star_id == star_id))
    ).scalar_one_or_none()
    if not message or not message.ack_required:
        raise HTTPException(status_code=404, detail="Объявление не найдено")
    return message


class AckOut(BaseModel):
    ack_count: int


@router.post("/{star_id}/messages/{message_id}/ack", response_model=AckOut)
async def ack(star_id: str, message_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    message = await _ack_message(db, star_id, message_id)
    await db.execute(
        insert(StarMessageAck).values(message_id=message_id, user_id=current_user.id).on_conflict_do_nothing()
    )
    await db.commit()
    count = (
        await db.execute(select(func.count()).select_from(StarMessageAck).where(StarMessageAck.message_id == message_id))
    ).scalar_one()
    await _broadcast(
        db, star_id,
        {"type": "star_ack", "channel_id": message.channel_id, "message_id": message_id, "ack_count": count},
    )
    return AckOut(ack_count=count)


@router.get("/{star_id}/messages/{message_id}/acks", response_model=AcksOut)
async def acks(star_id: str, message_id: str, current_user: CurrentUser, db: Db):
    """Кто ознакомился, а кто ещё нет — автору объявления, владельцу и админам."""
    _, me = await _load_membership(db, star_id, current_user.id)
    message = await _ack_message(db, star_id, message_id)
    if message.sender_id != current_user.id and me.role not in ("owner", "admin"):
        raise _forbid("Список видят автор объявления, владелец и админы")
    acked_ids = set(
        (await db.execute(select(StarMessageAck.user_id).where(StarMessageAck.message_id == message_id))).scalars().all()
    )
    users = (
        await db.execute(
            select(User).join(StarMember, StarMember.user_id == User.id).where(StarMember.star_id == star_id)
        )
    ).scalars().all()
    return await pseudonyms.in_star(db, star_id, AcksOut(
        acked=[_user_out(u) for u in users if u.id in acked_ids],
        pending=[_user_out(u) for u in users if u.id not in acked_ids and u.id != message.sender_id],
    ))


# --- Рабочее время ------------------------------------------------------------------


class Schedule(BaseModel):
    days: list[int]
    start: str
    end: str
    tz: str


def _checked(schedule: Schedule | None) -> dict | None:
    if schedule is None:
        return None
    try:
        return work_hours.normalize(schedule.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


class StarWorkHoursBody(BaseModel):
    enabled: bool
    # Общий график Звезды; null — по умолчанию (пн–пт, 9:00–18:00 по Москве).
    schedule: Schedule | None = None


@router.put("/{star_id}/work-hours", status_code=status.HTTP_204_NO_CONTENT)
async def set_star_work_hours(star_id: str, body: StarWorkHoursBody, current_user: CurrentUser, db: Db):
    """Рабочее время Звезды — включают и настраивают только владелец и админы."""
    star, me = await _load_membership(db, star_id, current_user.id)
    if me.role not in ("owner", "admin"):
        raise _forbid("Рабочее время настраивают владелец и админы")
    star.work_hours_enabled = body.enabled
    star.work_hours = _checked(body.schedule) or star.work_hours or dict(work_hours.DEFAULT_SCHEDULE)
    await db.commit()
    await _broadcast(
        db, star_id, {"type": "star_work_hours", "enabled": star.work_hours_enabled, "schedule": star.work_hours}
    )
    if body.enabled:
        # Графики участников теперь видны всем — разослать карточки.
        members = (await db.execute(select(StarMember).where(StarMember.star_id == star_id))).scalars().all()
        for member in members:
            await broadcast_member(db, member)
    await star_audit.record(db, star_id, current_user.id, "settings", fields=["work_hours"], enabled=body.enabled)


class MyScheduleBody(BaseModel):
    # null — как в каждой Звезде по умолчанию.
    schedule: Schedule | None


@me_router.put("/me/work-schedule", status_code=status.HTTP_204_NO_CONTENT)
async def set_my_schedule(body: MyScheduleBody, current_user: CurrentUser, db: Db):
    """Свой рабочий график — поверх общего графика каждой Звезды."""
    user = (await db.execute(select(User).where(User.id == current_user.id))).scalar_one()
    user.work_schedule = _checked(body.schedule)
    await db.commit()
    memberships = (
        await db.execute(
            select(StarMember)
            .join(Star, Star.id == StarMember.star_id)
            .where(StarMember.user_id == user.id, Star.work_hours_enabled.is_(True))
        )
    ).scalars().all()
    for member in memberships:
        await broadcast_member(db, member)
    await manager.send_to_user(user.id, {"type": "my_work_schedule", "schedule": user.work_schedule})


@me_router.get("/me/work-schedule", response_model=MyScheduleBody)
async def get_my_schedule(current_user: CurrentUser):
    return MyScheduleBody(schedule=current_user.work_schedule)


# --- Брони комнат -------------------------------------------------------------------

MAX_BOOKING = timedelta(hours=8)
BOOK_AHEAD = timedelta(days=60)
REMIND_BEFORE = timedelta(minutes=10)
# Сколько занятых дней серии перечислить в ответе 409.
BUSY_SHOWN = 20


class RepeatBody(BaseModel):
    """Повтор брони — см. app/core/recurrence.py."""

    freq: Literal["daily", "weekly", "monthly"]
    interval: int = Field(1, ge=1, le=recurrence.MAX_INTERVAL)
    weekdays: list[int] = Field(default_factory=list, max_length=7)
    monthly: Literal["day", "weekday", "last_weekday"] = "day"
    until: date | None = None
    count: int | None = Field(None, ge=2, le=recurrence.MAX_COUNT)


class BookingBody(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    starts_at: datetime
    ends_at: datetime
    attendees: list[str] = Field(default_factory=list, max_length=50)
    repeat: RepeatBody | None = None
    # Часовой пояс, в котором повторяется встреча (у человека в браузере); по умолчанию — Звезды.
    tz: str | None = Field(None, max_length=64)
    # Комната занята в часть дней серии — забронировать остальные.
    skip_busy: bool = False

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Пустое название")
        return v


class BookingOut(BaseModel):
    id: str
    channel_id: str
    title: str
    starts_at: datetime
    ends_at: datetime
    created_by: str | None
    attendees: list[str]
    # Встреча повторяющейся серии: её id и правило повтора.
    series_id: str | None = None
    repeat: dict | None = None


def _out(booking: StarBooking, rules: dict[str, dict]) -> BookingOut:
    return BookingOut(
        id=booking.id, channel_id=booking.channel_id, title=booking.title, starts_at=booking.starts_at,
        ends_at=booking.ends_at, created_by=booking.created_by, attendees=booking.attendees,
        series_id=booking.series_id, repeat=rules.get(booking.series_id or ""),
    )


async def _bookings_event(db: AsyncSession, star_id: str, channel_id: str) -> None:
    await _broadcast(db, star_id, {"type": "star_bookings", "channel_id": channel_id})


async def _tell(
    db: AsyncSession, star: Star | None, booking, user_ids, kind: str, title: str, body: str, *, push: bool
) -> None:
    """Уведомление о брони в зелёный колокольчик (и push, если просили): нажатие откроет комнату."""
    data = {
        "star_id": booking.star_id,
        "channel_id": booking.channel_id,
        "booking_id": booking.id,
        "title": booking.title,
        "starts_at": booking.starts_at.isoformat(),
        "ends_at": booking.ends_at.isoformat(),
    }
    if getattr(booking, "series_id", None):
        data["series_id"] = booking.series_id
    rows = await inbox.notify(db, user_ids, kind, title, body, data)
    if not push:
        return
    for row in rows:
        await send_push_to_user(
            row.user_id,
            {"type": "inbox", "title": title, "body": body, "tag": f"quazar-inbox-{row.id}",
             "star_id": booking.star_id, "channel_id": booking.channel_id, "notification_id": row.id},
        )


async def _room_name(db: AsyncSession, channel_id: str) -> str:
    return (await db.execute(select(StarChannel.name).where(StarChannel.id == channel_id))).scalar_one_or_none() or "комната"


def _series_text(star: Star | None, series: StarBookingSeries) -> str:
    """«по вторникам, 14:00–15:00»."""
    first = series.first_starts_at.astimezone(ZoneInfo(series.tz)).date()
    end = series.first_starts_at + timedelta(minutes=series.duration_min)
    return f"{recurrence.describe(series.rule, first)}, {_local(star, series.first_starts_at)}–{_local(star, end)}"


def _zone(name: str | None, star: Star) -> str:
    if name:
        try:
            ZoneInfo(name)
            return name
        except (ValueError, KeyError):
            pass
    return ((star.work_hours or None) or work_hours.DEFAULT_SCHEDULE)["tz"]


def _window(series: StarBookingSeries, until: datetime) -> tuple[list[datetime], bool]:
    """Ещё не разобранные встречи серии до until и закончилось ли на этом правило."""
    starts = []
    for start in recurrence.occurrences(series.rule, series.first_starts_at, series.tz):
        if start > until:
            return starts, False
        if start > series.generated_until or start == series.first_starts_at == series.generated_until:
            starts.append(start)
    return starts, True


async def _busy(
    db: AsyncSession, channel_id: str, spans: list[tuple[datetime, datetime]], exclude: set[str] | None = None
) -> dict[int, tuple]:
    """Какие из промежутков пересекаются с бронями комнаты: номер → (бронь, её автор).
    exclude — брони, которые сейчас переносим (сами с собой они не пересекаются)."""
    if not spans:
        return {}
    query = (
        select(StarBooking, User)
        .outerjoin(User, User.id == StarBooking.created_by)
        .where(
            StarBooking.channel_id == channel_id,
            StarBooking.starts_at < max(end for _, end in spans),
            StarBooking.ends_at > min(start for start, _ in spans),
        )
        .order_by(StarBooking.starts_at)
    )
    if exclude:
        query = query.where(StarBooking.id.not_in(exclude))
    rows = (await db.execute(query)).all()
    busy = {}
    for index, (start, end) in enumerate(spans):
        for booking, owner in rows:
            if booking.starts_at < end and booking.ends_at > start:
                busy[index] = (booking, owner)
                break
    return busy


@router.get("/{star_id}/bookings", response_model=list[BookingOut])
async def list_bookings(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    start: datetime | None = Query(None, alias="from"),
    end: datetime | None = Query(None, alias="to"),
):
    """Брони всех комнат Звезды в интервале (по умолчанию — с текущего момента на неделю вперёд).
    Брони комнат закрытых для меня этажей не показываем."""
    star, me = await _load_membership(db, star_id, current_user.id)
    view = await floors_svc.view_of(db, star, me)
    start = start or _now()
    end = end or start + timedelta(days=7)
    rows = await db.execute(
        select(StarBooking)
        .where(StarBooking.star_id == star_id, StarBooking.ends_at > start, StarBooking.starts_at < end)
        .order_by(StarBooking.starts_at)
    )
    bookings = list(rows.scalars().all())
    if view.closed:
        rooms = {c.id: c for c in (await db.execute(select(StarChannel).where(StarChannel.star_id == star_id))).scalars()}
        bookings = [b for b in bookings if b.channel_id not in rooms or view.sees_room(rooms[b.channel_id])]
    series_ids = {b.series_id for b in bookings if b.series_id}
    rules = {}
    if series_ids:
        rules = dict((await db.execute(
            select(StarBookingSeries.id, StarBookingSeries.rule).where(StarBookingSeries.id.in_(series_ids))
        )).all())
    return [_out(b, rules) for b in bookings]


@router.post("/{star_id}/channels/{channel_id}/bookings", response_model=BookingOut, status_code=status.HTTP_201_CREATED)
async def create_booking(star_id: str, channel_id: str, body: BookingBody, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    if star.kind != "work" or channel.kind != "planet" or channel.room_kind == "lobby":
        raise HTTPException(status_code=400, detail="Бронировать можно комнаты рабочей Звезды")
    if channel.access == "personal":
        raise HTTPException(status_code=400, detail="Личный кабинет не бронируют — повесьте табличку на дверь")
    await assert_room_access(db, star, me, channel)
    if me.timeout_until and me.timeout_until > _now():
        raise _forbid("Вы в тайм-ауте")
    for at in (body.starts_at, body.ends_at):
        if at.tzinfo is None:
            raise HTTPException(status_code=422, detail="Время нужно с часовым поясом")
    if body.ends_at <= body.starts_at:
        raise HTTPException(status_code=422, detail="Конец раньше начала")
    if body.ends_at - body.starts_at > MAX_BOOKING:
        raise HTTPException(status_code=422, detail="Не дольше 8 часов")
    if body.ends_at <= _now():
        raise HTTPException(status_code=422, detail="Это время уже прошло")
    if body.starts_at > _now() + BOOK_AHEAD:
        raise HTTPException(status_code=422, detail="Бронировать можно на 60 дней вперёд")
    members = set(
        (await db.execute(select(StarMember.user_id).where(StarMember.star_id == star_id))).scalars().all()
    )
    attendees = [uid for uid in dict.fromkeys(body.attendees) if uid in members and uid != current_user.id]
    if body.repeat:
        return await _create_series(db, star, channel, current_user, body, attendees)

    # Блокируем комнату: две одновременные брони не пересекутся.
    await db.execute(select(StarChannel.id).where(StarChannel.id == channel_id).with_for_update())
    clash = (await _busy(db, channel_id, [(body.starts_at, body.ends_at)])).get(0)
    if clash:
        booking, owner = clash
        owner_name = await pseudonyms.name_in_star(db, star_id, owner)
        raise HTTPException(
            status_code=409,
            detail=f"Комната занята: «{booking.title}» ({owner_name or 'кто-то'}) "
            f"с {_local(star, booking.starts_at)} до {_local(star, booking.ends_at)}",
        )
    booking = StarBooking(
        star_id=star_id, channel_id=channel_id, title=body.title, starts_at=body.starts_at,
        ends_at=body.ends_at, created_by=current_user.id, attendees=attendees,
    )
    db.add(booking)
    await db.commit()
    await _bookings_event(db, star_id, channel_id)
    if attendees:
        who = await pseudonyms.name_in_star(db, star_id, current_user) or current_user.display_name
        await _tell(
            db, star, booking, attendees, "booking_invite",
            f"{who} зовёт вас на встречу «{booking.title}»",
            f"«{channel.name}» · {_span(star, booking.starts_at, booking.ends_at)} · {star.name}",
            push=True,
        )
    return _out(booking, {})


async def _create_series(
    db: AsyncSession, star: Star, channel: StarChannel, user: User, body: BookingBody, attendees: list[str]
) -> BookingOut:
    """Повторяющаяся бронь: встречи на BOOK_AHEAD вперёд сразу, дальше — планировщик (extend_series)."""
    tz = _zone(body.tz, star)
    try:
        rule = recurrence.normalize(body.repeat.model_dump(), body.starts_at.astimezone(ZoneInfo(tz)).date())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    duration = body.ends_at - body.starts_at
    series = StarBookingSeries(
        star_id=star.id, channel_id=channel.id, title=body.title, created_by=user.id, attendees=attendees,
        rule=rule, tz=tz, first_starts_at=body.starts_at, duration_min=int(duration.total_seconds() // 60),
        generated_until=body.starts_at,
    )
    duration = timedelta(minutes=series.duration_min)
    horizon = _now() + BOOK_AHEAD
    starts, finished = _window(series, horizon)
    spans = [(start, start + duration) for start in starts]

    await db.execute(select(StarChannel.id).where(StarChannel.id == channel.id).with_for_update())
    busy = await _busy(db, channel.id, spans)
    if busy and (not body.skip_busy or len(busy) == len(spans)):
        names = {}
        listed = []
        for index in sorted(busy)[:BUSY_SHOWN]:
            booking, owner = busy[index]
            if owner and owner.id not in names:
                names[owner.id] = await pseudonyms.name_in_star(db, star.id, owner)
            listed.append({
                "starts_at": spans[index][0].isoformat(), "ends_at": spans[index][1].isoformat(),
                "title": booking.title, "who": names.get(owner.id) if owner else None,
            })
        free = len(spans) - len(busy)
        message = (
            "Комната занята во все дни этой серии" if not free
            else f"Комната занята в {len(busy)} {_days(len(busy))} из {len(spans)} на ближайшие 60 дней"
        )
        raise HTTPException(status_code=409, detail={"message": message, "busy": listed, "free": free})

    db.add(series)
    await db.flush()
    created = [
        StarBooking(star_id=star.id, channel_id=channel.id, title=body.title, starts_at=start, ends_at=end,
                    created_by=user.id, attendees=attendees, series_id=series.id)
        for index, (start, end) in enumerate(spans) if index not in busy
    ]
    db.add_all(created)
    series.generated_until = horizon
    series.finished = finished
    await db.commit()
    await _bookings_event(db, star.id, channel.id)
    first = created[0]
    if attendees:
        who = await pseudonyms.name_in_star(db, star.id, user) or user.display_name
        await _tell(
            db, star, first, attendees, "booking_invite",
            f"{who} зовёт вас на регулярную встречу «{first.title}»",
            f"«{channel.name}» · {_series_text(star, series)} · с {first.starts_at.astimezone(ZoneInfo(tz)).strftime('%d.%m')}"
            f" · {star.name}",
            push=True,
        )
    return _out(first, {series.id: rule})


def _days(n: int) -> str:
    return "день" if n % 10 == 1 and n % 100 != 11 else "дня" if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else "дней"


async def extend_series(db: AsyncSession, now: datetime | None = None) -> int:
    """Дописывает встречи серий, чьи дни вошли в окно BOOK_AHEAD. Занятый день пропускаем и говорим
    автору серии. Каждую серию трогаем не чаще раза в час: окно сдвигается медленно."""
    now = now or _now()
    horizon = now + BOOK_AHEAD
    due = (
        await db.execute(
            select(StarBookingSeries)
            .where(StarBookingSeries.finished.is_(False), StarBookingSeries.generated_until < horizon - timedelta(hours=1))
            .with_for_update(skip_locked=True)
            .limit(50)
        )
    ).scalars().all()
    made = 0
    for series in due:
        star = await db.get(Star, series.star_id)
        members = set(
            (await db.execute(select(StarMember.user_id).where(StarMember.star_id == series.star_id))).scalars().all()
        )
        if not star or star.kind != "work" or series.created_by not in members:
            # Автор ушёл из Звезды — новых встреч от его имени не ставим.
            series.finished = True
            await db.commit()
            continue
        duration = timedelta(minutes=series.duration_min)
        starts, finished = _window(series, horizon)
        spans = [(start, start + duration) for start in starts]
        await db.execute(select(StarChannel.id).where(StarChannel.id == series.channel_id).with_for_update())
        busy = await _busy(db, series.channel_id, spans)
        attendees = [uid for uid in series.attendees if uid in members]
        created = [
            StarBooking(star_id=series.star_id, channel_id=series.channel_id, title=series.title, starts_at=start,
                        ends_at=end, created_by=series.created_by, attendees=attendees, series_id=series.id)
            for index, (start, end) in enumerate(spans) if index not in busy
        ]
        db.add_all(created)
        series.attendees = attendees
        series.generated_until = horizon
        series.finished = finished
        await db.commit()
        made += len(created)
        if created:
            await _bookings_event(db, series.star_id, series.channel_id)
        if busy:
            room = await _room_name(db, series.channel_id)
        for index in sorted(busy):
            other, owner = busy[index]
            owner_name = await pseudonyms.name_in_star(db, series.star_id, owner) if owner else None
            skipped = SimpleNamespace(
                star_id=series.star_id, channel_id=series.channel_id, id=None, series_id=series.id,
                title=series.title, starts_at=spans[index][0], ends_at=spans[index][1],
            )
            await _tell(
                db, star, skipped, [series.created_by], "booking_busy",
                f"«{series.title}» {spans[index][0].astimezone(ZoneInfo(series.tz)).strftime('%d.%m')} не забронирована",
                f"«{room}» в это время занята: «{other.title}» ({owner_name or 'кто-то'}) · {star.name}",
                push=True,
            )
    return made


@router.delete("/{star_id}/bookings/{booking_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_booking(
    star_id: str,
    booking_id: str,
    current_user: CurrentUser,
    db: Db,
    # Для встречи серии: one — только эту, following — эту и следующие, all — всю серию.
    scope: Annotated[Literal["one", "following", "all"], Query()] = "one",
):
    star, me = await _load_membership(db, star_id, current_user.id)
    booking = (
        await db.execute(select(StarBooking).where(StarBooking.id == booking_id, StarBooking.star_id == star_id))
    ).scalar_one_or_none()
    if not booking:
        raise HTTPException(status_code=404, detail="Бронь не найдена")
    if booking.created_by != current_user.id and me.role not in ("owner", "admin"):
        raise _forbid("Отменить может автор брони, владелец или админ")
    series = await db.get(StarBookingSeries, booking.series_id) if booking.series_id and scope != "one" else None
    channel_id = booking.channel_id
    room = await _room_name(db, channel_id)
    who = await pseudonyms.name_in_star(db, star_id, current_user) or current_user.display_name
    if series is None:
        # Прошедшую встречу отменять не о чем сообщать — только ещё не закончившуюся.
        tell = [uid for uid in {booking.created_by, *booking.attendees} if uid and uid != current_user.id] \
            if booking.ends_at > _now() else []
        await db.delete(booking)
        await db.commit()
        await _bookings_event(db, star_id, channel_id)
        if tell:
            await _tell(
                db, star, booking, tell, "booking_cancelled",
                f"Встреча «{booking.title}» отменена",
                f"«{room}» · {_span(star, booking.starts_at, booking.ends_at)} · {star.name} · отменил(а) {who}",
                push=True,
            )
        return

    query = select(StarBooking).where(StarBooking.series_id == series.id)
    if scope == "following":
        query = query.where(StarBooking.starts_at >= booking.starts_at)
    else:
        query = query.where(StarBooking.ends_at > _now())
    doomed = list((await db.execute(query)).scalars().all())
    tell = [uid for uid in {series.created_by, *series.attendees} if uid and uid != current_user.id] \
        if any(b.ends_at > _now() for b in doomed) else []
    text = _series_text(star, series)
    for b in doomed:
        await db.delete(b)
    if scope == "following":
        series.finished = True
    else:
        # Прошедшие встречи остаются в истории разовыми (series_id обнулит база).
        await db.delete(series)
    await db.commit()
    await _bookings_event(db, star_id, channel_id)
    if tell:
        since = booking.starts_at.astimezone(ZoneInfo(series.tz)).strftime("%d.%m")
        title = (f"Встречи «{booking.title}» отменены с {since}" if scope == "following"
                 else f"Регулярная встреча «{booking.title}» отменена")
        await _tell(
            db, star, booking, tell, "booking_cancelled", title,
            f"«{room}» · {text} · {star.name} · отменил(а) {who}",
            push=True,
        )


class BookingEdit(BaseModel):
    """Новые тема, время и участники брони (присылают всё целиком)."""

    title: str = Field(min_length=1, max_length=100)
    starts_at: datetime
    ends_at: datetime
    attendees: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        return BookingBody._title(v)


async def _busy_detail(db: AsyncSession, star: Star, busy: dict[int, tuple], spans: list[tuple[datetime, datetime]]) -> list[dict]:
    names: dict[str, str | None] = {}
    listed = []
    for index in sorted(busy)[:BUSY_SHOWN]:
        other, owner = busy[index]
        if owner and owner.id not in names:
            names[owner.id] = await pseudonyms.name_in_star(db, star.id, owner)
        listed.append({
            "starts_at": spans[index][0].isoformat(), "ends_at": spans[index][1].isoformat(),
            "title": other.title, "who": names.get(owner.id) if owner else None,
        })
    return listed


@router.put("/{star_id}/bookings/{booking_id}", response_model=BookingOut)
async def update_booking(
    star_id: str,
    booking_id: str,
    body: BookingEdit,
    current_user: CurrentUser,
    db: Db,
    # Для встречи серии: one — только эту, following — эту и следующие, all — все ещё не прошедшие.
    scope: Annotated[Literal["one", "following", "all"], Query()] = "one",
):
    """Изменить тему, время и участников. У нескольких встреч серии день не меняется — только время:
    каждая встреча остаётся в свой день. Комната занята в новое время — ничего не меняем (409)."""
    star, me = await _load_membership(db, star_id, current_user.id)
    booking = (
        await db.execute(select(StarBooking).where(StarBooking.id == booking_id, StarBooking.star_id == star_id))
    ).scalar_one_or_none()
    if not booking:
        raise HTTPException(status_code=404, detail="Бронь не найдена")
    if booking.created_by != current_user.id and me.role not in ("owner", "admin"):
        raise _forbid("Изменить может автор брони, владелец или админ")
    for at in (body.starts_at, body.ends_at):
        if at.tzinfo is None:
            raise HTTPException(status_code=422, detail="Время нужно с часовым поясом")
    if body.ends_at <= body.starts_at:
        raise HTTPException(status_code=422, detail="Конец раньше начала")
    if body.ends_at - body.starts_at > MAX_BOOKING:
        raise HTTPException(status_code=422, detail="Не дольше 8 часов")
    now = _now()
    members = set(
        (await db.execute(select(StarMember.user_id).where(StarMember.star_id == star_id))).scalars().all()
    )
    attendees = [uid for uid in dict.fromkeys(body.attendees) if uid in members and uid != booking.created_by]
    series = await db.get(StarBookingSeries, booking.series_id) if booking.series_id and scope != "one" else None

    if series is None:
        if body.ends_at <= now:
            raise HTTPException(status_code=422, detail="Это время уже прошло")
        if body.starts_at > now + BOOK_AHEAD:
            raise HTTPException(status_code=422, detail="Бронировать можно на 60 дней вперёд")
        targets = [(booking, body.starts_at, body.ends_at)]
    else:
        zone = ZoneInfo(series.tz)
        if body.starts_at.astimezone(zone).date() != booking.starts_at.astimezone(zone).date():
            raise HTTPException(status_code=422, detail="День меняют только у одной встречи — выберите «Только эту встречу»")
        wall = body.starts_at.astimezone(zone).time()
        duration = body.ends_at - body.starts_at
        query = select(StarBooking).where(StarBooking.series_id == series.id).order_by(StarBooking.starts_at)
        query = query.where(StarBooking.starts_at >= booking.starts_at) if scope == "following" \
            else query.where(StarBooking.ends_at > now)
        targets = []
        for b in (await db.execute(query)).scalars().all():
            start = datetime.combine(b.starts_at.astimezone(zone).date(), wall, tzinfo=zone)
            if start + duration > now:  # уже закончившуюся в новом времени не трогаем
                targets.append((b, start, start + duration))
        if not targets:
            raise HTTPException(status_code=422, detail="Это время уже прошло")

    await db.execute(select(StarChannel.id).where(StarChannel.id == booking.channel_id).with_for_update())
    spans = [(start, end) for _, start, end in targets]
    busy = await _busy(db, booking.channel_id, spans, exclude={b.id for b, _, _ in targets})
    if busy and series is None:
        other, owner = busy[0]
        owner_name = await pseudonyms.name_in_star(db, star_id, owner)
        raise HTTPException(
            status_code=409,
            detail=f"Комната занята: «{other.title}» ({owner_name or 'кто-то'}) "
            f"с {_local(star, other.starts_at)} до {_local(star, other.ends_at)}",
        )
    if busy:
        raise HTTPException(status_code=409, detail={
            "message": f"В новое время комната занята в {len(busy)} {_days(len(busy))} из {len(spans)} — ничего не изменено",
            "busy": await _busy_detail(db, star, busy, spans), "free": 0,
        })

    before = set(booking.attendees)
    old_span = (booking.starts_at, booking.ends_at)
    for b, start, end in targets:
        if start != b.starts_at and start > now:
            # Новое время — напомнить и поставить «на встрече» заново.
            b.reminded = False
            b.started = False
        b.title, b.attendees, b.starts_at, b.ends_at = body.title, attendees, start, end
    if series is not None:
        # Следующие встречи серии планировщик создаст уже по-новому.
        zone = ZoneInfo(series.tz)
        first_day = series.first_starts_at.astimezone(zone).date()
        series.first_starts_at = datetime.combine(first_day, body.starts_at.astimezone(zone).time(), tzinfo=zone)
        series.duration_min = int((body.ends_at - body.starts_at).total_seconds() // 60)
        series.title, series.attendees = body.title, attendees
    await db.commit()
    await _bookings_event(db, star_id, booking.channel_id)

    first = targets[0][0]
    room = await _room_name(db, booking.channel_id)
    who = await pseudonyms.name_in_star(db, star_id, current_user) or current_user.display_name
    when = _series_text(star, series) if series is not None else _span(star, first.starts_at, first.ends_at)
    regular = "регулярную " if series is not None else ""
    after = set(attendees)
    added = [uid for uid in attendees if uid not in before and uid != current_user.id]
    removed = [uid for uid in before - after if uid != current_user.id]
    kept = [uid for uid in {booking.created_by, *(before & after)} if uid and uid != current_user.id]
    if added:
        await _tell(db, star, first, added, "booking_invite", f"{who} зовёт вас на {regular}встречу «{first.title}»",
                    f"«{room}» · {when} · {star.name}", push=True)
    if removed:
        await _tell(db, star, first, removed, "booking_cancelled", f"Вас убрали из встречи «{first.title}»",
                    f"«{room}» · {when} · {star.name} · изменил(а) {who}", push=True)
    if kept:
        moved = series is not None or (first.starts_at, first.ends_at) != old_span
        await _tell(db, star, first, kept, "booking_changed", f"Встреча «{first.title}» изменена",
                    f"«{room}» · {when} · {star.name} · изменил(а) {who}", push=moved)
    rules = {series.id: series.rule} if series is not None else {}
    if first.series_id and not rules:
        rule = (await db.execute(select(StarBookingSeries.rule).where(StarBookingSeries.id == first.series_id))).scalar_one_or_none()
        rules = {first.series_id: rule} if rule else {}
    return _out(first, rules)


async def booking_tick(db: AsyncSession, now: datetime | None = None) -> int:
    """За 10 минут — напоминание участникам; в начале — статус «на встрече» до конца брони."""
    now = now or _now()
    done = 0
    soon = (
        await db.execute(
            select(StarBooking)
            .where(StarBooking.reminded.is_(False), StarBooking.starts_at <= now + REMIND_BEFORE, StarBooking.ends_at > now)
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    for b in soon:
        b.reminded = True
        await db.commit()
        room = (await db.execute(select(StarChannel.name).where(StarChannel.id == b.channel_id))).scalar_one_or_none()
        star = (await db.execute(select(Star).where(Star.id == b.star_id))).scalar_one_or_none()
        people = [uid for uid in {b.created_by, *b.attendees} if uid]
        for uid in people:
            await manager.send_to_user(
                uid,
                {"type": "star_booking_soon", "star_id": b.star_id, "channel_id": b.channel_id, "booking_id": b.id,
                 "title": b.title, "room": room, "starts_at": b.starts_at.isoformat()},
            )
        await _tell(
            db, star, b, people, "booking_soon",
            f"Скоро встреча «{b.title}»",
            f"«{room}» в {_local(star, b.starts_at)} · {star.name if star else ''}".rstrip(" ·"),
            push=True,
        )
        done += 1
    starting = (
        await db.execute(
            select(StarBooking)
            .where(StarBooking.started.is_(False), StarBooking.starts_at <= now, StarBooking.ends_at > now)
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    for b in starting:
        b.started = True
        await db.commit()
        star = (await db.execute(select(Star).where(Star.id == b.star_id))).scalar_one_or_none()
        room = await _room_name(db, b.channel_id)
        await _tell(
            db, star, b, [uid for uid in {b.created_by, *b.attendees} if uid], "booking_started",
            f"Началась встреча «{b.title}»",
            f"«{room}» до {_local(star, b.ends_at)} · {star.name if star else ''}".rstrip(" ·"),
            push=False,
        )
        for uid in {b.created_by, *b.attendees} - {None}:
            current = (await db.execute(select(User.manual_status, User.manual_status_until).where(User.id == uid))).first()
            busy = current and current[0] and (current[1] is None or current[1] > now)
            if not busy:  # «Не беспокоить» или свой статус не перебиваем
                try:
                    await presence.set_manual(uid, "meeting", b.ends_at)
                except Exception:  # noqa: BLE001
                    log.warning("meeting status for %s failed", uid)
        done += 1
    return done


# --- Табличка на двери кабинета --------------------------------------------------------


class DoorSignBody(BaseModel):
    # dnd — «Не беспокоить», welcome — «Заходите», away — «Скоро вернусь», custom — свой текст; null — снять.
    kind: Literal["dnd", "welcome", "away", "custom"] | None
    text: str | None = Field(default=None, max_length=80)
    until: datetime | None = None


@router.put("/{star_id}/channels/{channel_id}/door-sign", status_code=status.HTTP_204_NO_CONTENT)
async def set_door_sign(star_id: str, channel_id: str, body: DoorSignBody, current_user: CurrentUser, db: Db):
    """Табличку вешает хозяин кабинета (или владелец и админы Звезды)."""
    _, me = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    if channel.access != "personal":
        raise HTTPException(status_code=400, detail="Табличка — только на личном кабинете")
    if channel.cabinet_owner_id != current_user.id and me.role not in ("owner", "admin"):
        raise _forbid("Табличку вешает хозяин кабинета")
    if body.kind == "custom" and not (body.text or "").strip():
        raise HTTPException(status_code=422, detail="Напишите текст таблички")
    if body.until is not None and (body.until.tzinfo is None or body.until <= _now()):
        raise HTTPException(status_code=422, detail="Срок таблички должен быть в будущем")
    channel.door_sign_kind = body.kind
    channel.door_sign_text = (body.text or "").strip() or None if body.kind else None
    channel.door_sign_until = body.until if body.kind else None
    await db.commit()
    await _broadcast(db, star_id, _channel_event(channel))

"""Рабочие Звёзды: ветки, объявления с «Ознакомлен(а)», рабочее время, брони комнат, табличка на двери."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import (
    _as_star,
    _broadcast,
    _channel,
    _channel_event,
    _forbid,
    _load_membership,
    _messages_out,
    _require_perm,
    _satellite,
    _star_message,
    _user_out,
    broadcast_member,
)
from app.core import presence, star_audit, work_hours
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.push import send_push_to_user
from app.core.stars import Perm
from app.models.star import Star, StarBooking, StarChannel, StarMember, StarMessage, StarMessageAck
from app.models.user import User
from app.schemas.star import StarMessageOut, StarUserOut
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
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
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
    return _as_star(await _messages_out(db, [(root, sender), *[(m, u) for m, u in reversed(rows)]], current_user.id), star_id)


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
    return AcksOut(
        acked=[_user_out(u) for u in users if u.id in acked_ids],
        pending=[_user_out(u) for u in users if u.id not in acked_ids and u.id != message.sender_id],
    )


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


class BookingBody(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    starts_at: datetime
    ends_at: datetime
    attendees: list[str] = Field(default_factory=list, max_length=50)

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

    model_config = {"from_attributes": True}


async def _bookings_event(db: AsyncSession, star_id: str, channel_id: str) -> None:
    await _broadcast(db, star_id, {"type": "star_bookings", "channel_id": channel_id})


@router.get("/{star_id}/bookings", response_model=list[BookingOut])
async def list_bookings(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    start: datetime | None = Query(None, alias="from"),
    end: datetime | None = Query(None, alias="to"),
):
    """Брони всех комнат Звезды в интервале (по умолчанию — с текущего момента на неделю вперёд)."""
    await _load_membership(db, star_id, current_user.id)
    start = start or _now()
    end = end or start + timedelta(days=7)
    rows = await db.execute(
        select(StarBooking)
        .where(StarBooking.star_id == star_id, StarBooking.ends_at > start, StarBooking.starts_at < end)
        .order_by(StarBooking.starts_at)
    )
    return list(rows.scalars().all())


@router.post("/{star_id}/channels/{channel_id}/bookings", response_model=BookingOut, status_code=status.HTTP_201_CREATED)
async def create_booking(star_id: str, channel_id: str, body: BookingBody, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    if star.kind != "work" or channel.kind != "planet" or channel.room_kind == "lobby":
        raise HTTPException(status_code=400, detail="Бронировать можно комнаты рабочей Звезды")
    if channel.access == "personal":
        raise HTTPException(status_code=400, detail="Личный кабинет не бронируют — повесьте табличку на дверь")
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

    # Блокируем комнату: две одновременные брони не пересекутся.
    await db.execute(select(StarChannel.id).where(StarChannel.id == channel_id).with_for_update())
    clash = (
        await db.execute(
            select(StarBooking, User)
            .outerjoin(User, User.id == StarBooking.created_by)
            .where(
                StarBooking.channel_id == channel_id,
                and_(StarBooking.starts_at < body.ends_at, StarBooking.ends_at > body.starts_at),
            )
            .limit(1)
        )
    ).first()
    if clash:
        booking, owner = clash
        raise HTTPException(
            status_code=409,
            detail=f"Комната занята: «{booking.title}» ({owner.display_name if owner else 'кто-то'}) "
            f"с {_local(star, booking.starts_at)} до {_local(star, booking.ends_at)}",
        )
    booking = StarBooking(
        star_id=star_id, channel_id=channel_id, title=body.title, starts_at=body.starts_at,
        ends_at=body.ends_at, created_by=current_user.id, attendees=attendees,
    )
    db.add(booking)
    await db.commit()
    await _bookings_event(db, star_id, channel_id)
    return booking


@router.delete("/{star_id}/bookings/{booking_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_booking(star_id: str, booking_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    booking = (
        await db.execute(select(StarBooking).where(StarBooking.id == booking_id, StarBooking.star_id == star_id))
    ).scalar_one_or_none()
    if not booking:
        raise HTTPException(status_code=404, detail="Бронь не найдена")
    if booking.created_by != current_user.id and me.role not in ("owner", "admin"):
        raise _forbid("Отменить может автор брони, владелец или админ")
    channel_id = booking.channel_id
    await db.delete(booking)
    await db.commit()
    await _bookings_event(db, star_id, channel_id)


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
        for uid in {b.created_by, *b.attendees} - {None}:
            await manager.send_to_user(
                uid,
                {"type": "star_booking_soon", "star_id": b.star_id, "channel_id": b.channel_id, "booking_id": b.id,
                 "title": b.title, "room": room, "starts_at": b.starts_at.isoformat()},
            )
            await send_push_to_user(
                uid,
                {"title": f"Встреча «{b.title}»", "body": f"в «{room}» в {_local(star, b.starts_at)}",
                 "tag": f"quazar-booking-{b.id}"},
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

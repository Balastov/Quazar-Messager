"""Игровое в Звёздах: опросы, сбор группы, временные Планеты, стикеры/эмодзи/звуки и звуковая панель."""

import re
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import (
    _broadcast,
    _channel_event,
    _forbid,
    _load_membership,
    _messages_out,
    _require_perm,
    _satellite,
    assert_can_post,
    assert_clean_text,
    assert_slow_mode,
)
from app.core import star_assets, voice
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.push import send_push_to_user
from app.core.stars import Perm
from app.models.star import (
    Star,
    StarAsset,
    StarChannel,
    StarLfg,
    StarLfgMember,
    StarMessage,
    StarPoll,
    StarPollVote,
)
from app.models.user import User
from app.schemas.star import LfgOut, PollOptionOut, PollOut, StarChannelOut
from app.ws.hub import manager

router = APIRouter(prefix="/stars", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _post_message(db: AsyncSession, star_id: str, channel_id: str, user: User, kind: str, text: str, ref_id: str) -> None:
    message = StarMessage(star_id=star_id, channel_id=channel_id, sender_id=user.id, text=text, kind=kind, ref_id=ref_id)
    db.add(message)
    await db.commit()
    out = (await _messages_out(db, [(message, user)]))[0]
    await _broadcast(db, star_id, {"type": "star_message", "message": out.model_dump(mode="json")})


async def _message_of(db: AsyncSession, kind: str, ref_id: str) -> StarMessage | None:
    return (
        await db.execute(select(StarMessage).where(StarMessage.kind == kind, StarMessage.ref_id == ref_id))
    ).scalar_one_or_none()


# --- Опросы --------------------------------------------------------------------


class PollBody(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    options: list[str] = Field(min_length=2, max_length=10)
    multiple: bool = False
    anonymous: bool = False
    # Закрыть сам через столько минут (5 минут — неделя); null — пока не закроют.
    closes_in_minutes: int | None = Field(default=None, ge=5, le=10080)

    @field_validator("question")
    @classmethod
    def _question(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Пустой вопрос")
        return v

    @field_validator("options")
    @classmethod
    def _options(cls, v: list[str]) -> list[str]:
        cleaned = [" ".join(o.split())[:100] for o in v]
        if any(not o for o in cleaned):
            raise ValueError("Пустой вариант ответа")
        if len(set(o.lower() for o in cleaned)) != len(cleaned):
            raise ValueError("Варианты повторяются")
        return cleaned


class VoteBody(BaseModel):
    # Номера вариантов; пустой список — отозвать голос.
    options: list[int] = Field(max_length=10)


def _poll_closed(poll: StarPoll) -> bool:
    return poll.closed or (poll.closes_at is not None and poll.closes_at <= _now())


async def polls_out(db: AsyncSession, ids: list[str], viewer_id: str | None) -> dict[str, PollOut]:
    if not ids:
        return {}
    polls = (await db.execute(select(StarPoll).where(StarPoll.id.in_(ids)))).scalars().all()
    votes = (await db.execute(select(StarPollVote).where(StarPollVote.poll_id.in_(ids)))).scalars().all()
    by_poll: dict[str, list[StarPollVote]] = defaultdict(list)
    for v in votes:
        by_poll[v.poll_id].append(v)
    out: dict[str, PollOut] = {}
    for poll in polls:
        pv = by_poll[poll.id]
        options = []
        for i, text in enumerate(poll.options):
            voters = [v.user_id for v in pv if v.option == i]
            options.append(PollOptionOut(text=text, votes=len(voters), voters=[] if poll.anonymous else voters))
        out[poll.id] = PollOut(
            id=poll.id,
            question=poll.question,
            options=options,
            multiple=poll.multiple,
            anonymous=poll.anonymous,
            closes_at=poll.closes_at,
            closed=_poll_closed(poll),
            total_voters=len({v.user_id for v in pv}),
            my_votes=sorted(v.option for v in pv if v.user_id == viewer_id),
            created_by=poll.created_by,
        )
    return out


async def _poll_event(db: AsyncSession, poll: StarPoll) -> None:
    message = await _message_of(db, "poll", poll.id)
    if not message:
        return
    out = (await polls_out(db, [poll.id], None))[poll.id]
    await _broadcast(
        db,
        poll.star_id,
        {"type": "star_poll", "channel_id": message.channel_id, "message_id": message.id, "poll": out.model_dump(mode="json")},
    )


async def _poll(db: AsyncSession, star_id: str, poll_id: str) -> StarPoll:
    poll = (
        await db.execute(select(StarPoll).where(StarPoll.id == poll_id, StarPoll.star_id == star_id))
    ).scalar_one_or_none()
    if not poll:
        raise HTTPException(status_code=404, detail="Опрос не найден")
    return poll


@router.post("/{star_id}/channels/{channel_id}/polls", status_code=status.HTTP_201_CREATED)
async def create_poll(star_id: str, channel_id: str, body: PollBody, current_user: CurrentUser, db: Db) -> dict:
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _satellite(db, star_id, channel_id)
    assert_can_post(star, me)
    await assert_slow_mode(db, channel, me)
    assert_clean_text(star, me, " ".join([body.question, *body.options]))
    poll = StarPoll(
        star_id=star_id,
        question=body.question,
        options=body.options,
        multiple=body.multiple,
        anonymous=body.anonymous,
        closes_at=_now() + timedelta(minutes=body.closes_in_minutes) if body.closes_in_minutes else None,
        created_by=current_user.id,
    )
    db.add(poll)
    await db.flush()
    await _post_message(db, star_id, channel_id, current_user, "poll", body.question, poll.id)
    return {"id": poll.id}


@router.put("/{star_id}/polls/{poll_id}/vote", response_model=PollOut)
async def vote(star_id: str, poll_id: str, body: VoteBody, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    poll = await _poll(db, star_id, poll_id)
    assert_can_post(star, me)
    if _poll_closed(poll):
        raise HTTPException(status_code=409, detail="Опрос уже закрыт")
    chosen = sorted(set(body.options))
    if any(i < 0 or i >= len(poll.options) for i in chosen):
        raise HTTPException(status_code=422, detail="Такого варианта нет")
    if not poll.multiple and len(chosen) > 1:
        raise HTTPException(status_code=422, detail="Здесь можно выбрать только один вариант")
    await db.execute(
        delete(StarPollVote).where(StarPollVote.poll_id == poll_id, StarPollVote.user_id == current_user.id)
    )
    db.add_all([StarPollVote(poll_id=poll_id, user_id=current_user.id, option=i) for i in chosen])
    await db.commit()
    await _poll_event(db, poll)
    return (await polls_out(db, [poll_id], current_user.id))[poll_id]


@router.post("/{star_id}/polls/{poll_id}/close", status_code=status.HTTP_204_NO_CONTENT)
async def close_poll(star_id: str, poll_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    poll = await _poll(db, star_id, poll_id)
    if poll.created_by != current_user.id and not rules.is_staff(me.role):
        raise _forbid("Закрыть опрос может его автор или модератор")
    poll.closed = True
    await db.commit()
    await _poll_event(db, poll)


# --- Временные Планеты ---------------------------------------------------------

# Пустая временная Планета живёт столько после создания — успеть зайти.
TEMP_PLANET_GRACE = timedelta(minutes=3)


class TempPlanetBody(BaseModel):
    name: str | None = Field(default=None, max_length=48)


async def create_temporary_planet(
    db: AsyncSession, star_id: str, creator_id: str | None, name: str, capacity: int = rules.DEFAULT_PLANET_CAPACITY
) -> StarChannel:
    await db.execute(select(Star.id).where(Star.id == star_id).with_for_update())
    count, top = (
        await db.execute(
            select(func.count(), func.max(StarChannel.position)).where(
                StarChannel.star_id == star_id, StarChannel.kind == "planet"
            )
        )
    ).one()
    temporary = (
        await db.execute(
            select(func.count()).where(StarChannel.star_id == star_id, StarChannel.temporary.is_(True))
        )
    ).scalar_one()
    if temporary >= rules.MAX_TEMP_PLANETS:
        raise HTTPException(status_code=409, detail=f"Временных Планет уже {rules.MAX_TEMP_PLANETS} — подождите, пока какая-то опустеет")
    channel = StarChannel(
        star_id=star_id,
        kind="planet",
        name=name[:48],
        position=(top or 0) + 1,
        capacity=min(max(capacity, 2), rules.PLANET_MAX_CAPACITY),
        temporary=True,
        created_by=creator_id,
    )
    db.add(channel)
    await db.commit()
    await _broadcast(db, star_id, _channel_event(channel))
    return channel


@router.post("/{star_id}/planets/temporary", response_model=StarChannelOut, status_code=status.HTTP_201_CREATED)
async def new_temporary_planet(star_id: str, body: TempPlanetBody, current_user: CurrentUser, db: Db):
    """Временная Планета: создаёт любой участник, в лимит Планет не входит, пустая — исчезает сама."""
    star, me = await _load_membership(db, star_id, current_user.id)
    assert_can_post(star, me)
    name = " ".join((body.name or "").split()) or f"Планета {current_user.username}"
    return await create_temporary_planet(db, star_id, current_user.id, name)


async def sweep_temporary_planets(db: AsyncSession, now: datetime | None = None) -> int:
    """Опустевшие временные Планеты (старше TEMP_PLANET_GRACE) удаляются."""
    now = now or _now()
    rows = (
        await db.execute(
            select(StarChannel).where(
                StarChannel.temporary.is_(True), StarChannel.created_at < now - TEMP_PLANET_GRACE
            )
        )
    ).scalars().all()
    removed = 0
    for channel in rows:
        if voice.participants(channel.id):
            continue
        star_id, channel_id = channel.star_id, channel.id
        await db.delete(channel)
        await db.commit()
        await _broadcast(db, star_id, {"type": "star_channel_deleted", "channel_id": channel_id})
        await voice.close_planet(star_id, channel_id)
        removed += 1
    return removed


# --- Сбор группы ---------------------------------------------------------------


class LfgBody(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    slots: int = Field(ge=2, le=rules.PLANET_MAX_CAPACITY)
    starts_at: datetime | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Пустое название")
        return v


async def lfgs_out(db: AsyncSession, ids: list[str]) -> dict[str, LfgOut]:
    if not ids:
        return {}
    groups = (await db.execute(select(StarLfg).where(StarLfg.id.in_(ids)))).scalars().all()
    members = (
        await db.execute(
            select(StarLfgMember).where(StarLfgMember.lfg_id.in_(ids)).order_by(StarLfgMember.joined_at)
        )
    ).scalars().all()
    by_lfg: dict[str, list[str]] = defaultdict(list)
    for m in members:
        by_lfg[m.lfg_id].append(m.user_id)
    return {
        g.id: LfgOut(
            id=g.id,
            title=g.title,
            slots=g.slots,
            starts_at=g.starts_at,
            status=g.status,
            members=by_lfg[g.id],
            planet_id=g.planet_id,
            created_by=g.created_by,
        )
        for g in groups
    }


async def _lfg_event(db: AsyncSession, lfg: StarLfg) -> None:
    message = await _message_of(db, "lfg", lfg.id)
    if not message:
        return
    out = (await lfgs_out(db, [lfg.id]))[lfg.id]
    await _broadcast(
        db,
        lfg.star_id,
        {"type": "star_lfg", "channel_id": message.channel_id, "message_id": message.id, "lfg": out.model_dump(mode="json")},
    )


async def _lfg(db: AsyncSession, star_id: str, lfg_id: str) -> StarLfg:
    lfg = (
        await db.execute(select(StarLfg).where(StarLfg.id == lfg_id, StarLfg.star_id == star_id).with_for_update())
    ).scalar_one_or_none()
    if not lfg:
        raise HTTPException(status_code=404, detail="Сбор не найден")
    return lfg


@router.post("/{star_id}/channels/{channel_id}/lfg", status_code=status.HTTP_201_CREATED)
async def create_lfg(star_id: str, channel_id: str, body: LfgBody, current_user: CurrentUser, db: Db) -> dict:
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _satellite(db, star_id, channel_id)
    assert_can_post(star, me)
    await assert_slow_mode(db, channel, me)
    assert_clean_text(star, me, body.title)
    if body.starts_at is not None:
        if body.starts_at.tzinfo is None:
            raise HTTPException(status_code=422, detail="Время нужно с часовым поясом")
        if not _now() < body.starts_at < _now() + timedelta(days=30):
            raise HTTPException(status_code=422, detail="Начало — в ближайшие 30 дней")
    lfg = StarLfg(
        star_id=star_id, channel_id=channel_id, title=body.title, slots=body.slots,
        starts_at=body.starts_at, created_by=current_user.id,
    )
    db.add(lfg)
    await db.flush()
    db.add(StarLfgMember(lfg_id=lfg.id, user_id=current_user.id))
    await db.flush()
    await _post_message(db, star_id, channel_id, current_user, "lfg", body.title, lfg.id)
    return {"id": lfg.id}


@router.post("/{star_id}/lfg/{lfg_id}/join", response_model=LfgOut)
async def join_lfg(star_id: str, lfg_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    assert_can_post(star, me)
    lfg = await _lfg(db, star_id, lfg_id)
    if lfg.status != "open":
        raise HTTPException(status_code=409, detail="Сбор уже начался или отменён")
    members = (
        await db.execute(select(StarLfgMember.user_id).where(StarLfgMember.lfg_id == lfg_id))
    ).scalars().all()
    if current_user.id not in members:
        if len(members) >= lfg.slots:
            raise HTTPException(status_code=409, detail="Мест больше нет")
        db.add(StarLfgMember(lfg_id=lfg_id, user_id=current_user.id))
    await db.commit()
    await _lfg_event(db, lfg)
    return (await lfgs_out(db, [lfg_id]))[lfg_id]


@router.post("/{star_id}/lfg/{lfg_id}/leave", response_model=LfgOut)
async def leave_lfg(star_id: str, lfg_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    lfg = await _lfg(db, star_id, lfg_id)
    await db.execute(
        delete(StarLfgMember).where(StarLfgMember.lfg_id == lfg_id, StarLfgMember.user_id == current_user.id)
    )
    await db.commit()
    await _lfg_event(db, lfg)
    return (await lfgs_out(db, [lfg_id]))[lfg_id]


async def start_lfg(db: AsyncSession, lfg: StarLfg) -> StarChannel | None:
    """Сбор начинается: временная Планета на всех записавшихся, им — уведомление."""
    members = (
        await db.execute(select(StarLfgMember.user_id).where(StarLfgMember.lfg_id == lfg.id))
    ).scalars().all()
    if not members:
        lfg.status = "cancelled"
        await db.commit()
        await _lfg_event(db, lfg)
        return None
    planet = await create_temporary_planet(db, lfg.star_id, lfg.created_by, f"🎮 {lfg.title}", lfg.slots)
    lfg.status = "started"
    lfg.planet_id = planet.id
    await db.commit()
    await _lfg_event(db, lfg)
    star_name = (await db.execute(select(Star.name).where(Star.id == lfg.star_id))).scalar_one()
    for user_id in members:
        await manager.send_to_user(
            user_id,
            {"type": "star_lfg_start", "star_id": lfg.star_id, "lfg_id": lfg.id, "channel_id": planet.id,
             "title": lfg.title, "star_name": star_name},
        )
        await send_push_to_user(
            user_id,
            {"title": f"Сбор «{lfg.title}» начинается", "body": f"{star_name}: заходите на Планету",
             "tag": f"quazar-lfg-{lfg.id}"},
        )
    return planet


@router.post("/{star_id}/lfg/{lfg_id}/start", response_model=LfgOut)
async def start_lfg_now(star_id: str, lfg_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    lfg = await _lfg(db, star_id, lfg_id)
    if lfg.created_by != current_user.id and not rules.is_staff(me.role):
        raise _forbid("Начать сбор может его автор или модератор")
    if lfg.status != "open":
        raise HTTPException(status_code=409, detail="Сбор уже начался или отменён")
    await start_lfg(db, lfg)
    return (await lfgs_out(db, [lfg_id]))[lfg_id]


@router.post("/{star_id}/lfg/{lfg_id}/cancel", response_model=LfgOut)
async def cancel_lfg(star_id: str, lfg_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    lfg = await _lfg(db, star_id, lfg_id)
    if lfg.created_by != current_user.id and not rules.is_staff(me.role):
        raise _forbid("Отменить сбор может его автор или модератор")
    if lfg.status == "open":
        lfg.status = "cancelled"
        await db.commit()
        await _lfg_event(db, lfg)
    return (await lfgs_out(db, [lfg_id]))[lfg_id]


async def start_due_lfg(db: AsyncSession, now: datetime | None = None) -> int:
    """Сборы, чьё время пришло, начинаются сами."""
    rows = (
        await db.execute(
            select(StarLfg)
            .where(StarLfg.status == "open", StarLfg.starts_at.is_not(None), StarLfg.starts_at <= (now or _now()))
            .with_for_update(skip_locked=True)
        )
    ).scalars().all()
    for lfg in rows:
        await start_lfg(db, lfg)
    return len(rows)


# --- Стикеры, эмодзи, звуки ----------------------------------------------------

EMOJI_NAME = re.compile(r"^[a-z0-9_]{2,32}$")
LIMITS = {"sticker": rules.MAX_STICKERS, "emoji": rules.MAX_EMOJI, "sound": rules.MAX_SOUNDS}

# Встроенные звуки панели — файлы в web/public/sounds/board/.
BUILTIN_SOUNDS: dict[str, tuple[str, str]] = {
    "tada": ("Тадам", "🎉"),
    "rimshot": ("Ба-дум-тсс", "🥁"),
    "gong": ("Гонг", "🔔"),
    "fail": ("Провал", "📉"),
}


class AssetOut(BaseModel):
    id: str
    kind: Literal["sticker", "emoji", "sound"]
    name: str
    emoji: str | None
    url: str
    mime: str

    model_config = {"from_attributes": True}


async def _assets_event(db: AsyncSession, star_id: str) -> None:
    await _broadcast(db, star_id, {"type": "star_assets"})


@router.get("/{star_id}/assets", response_model=list[AssetOut])
async def list_assets(star_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    rows = await db.execute(select(StarAsset).where(StarAsset.star_id == star_id).order_by(StarAsset.created_at))
    return list(rows.scalars().all())


@router.post("/{star_id}/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    star_id: str,
    current_user: CurrentUser,
    db: Db,
    kind: Annotated[Literal["sticker", "emoji", "sound"], Form()],
    name: Annotated[str, Form(max_length=32)],
    file: Annotated[UploadFile, File()],
    emoji: Annotated[str | None, Form(max_length=16)] = None,
):
    """Стикер (картинка до 512 КБ), эмодзи :name: (до 128 КБ) или звук панели (до 400 КБ)."""
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    name = " ".join(name.split())
    if kind == "emoji":
        name = name.lower()
        if not EMOJI_NAME.match(name):
            raise HTTPException(status_code=422, detail="Имя эмодзи — латиница, цифры и _, от 2 до 32 символов")
    elif not name:
        raise HTTPException(status_code=422, detail="Нужно название")
    count = (
        await db.execute(
            select(func.count()).where(StarAsset.star_id == star_id, StarAsset.kind == kind)
        )
    ).scalar_one()
    if count >= LIMITS[kind]:
        raise HTTPException(status_code=409, detail=f"Не больше {LIMITS[kind]}")
    if kind == "emoji":
        taken = (
            await db.execute(
                select(StarAsset.id).where(StarAsset.star_id == star_id, StarAsset.kind == "emoji", StarAsset.name == name)
            )
        ).first()
        if taken:
            raise HTTPException(status_code=409, detail=f"Эмодзи :{name}: уже есть")
    limit = star_assets.MAX_BYTES[kind]
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"Файл больше {limit // 1024} КБ")
    detected = star_assets.detect(kind, data)
    if not detected:
        raise HTTPException(
            status_code=422,
            detail="Подойдёт звук OGG, MP3, WAV, WebM или M4A" if kind == "sound" else "Подойдёт картинка PNG, WebP, GIF или JPEG",
        )
    asset_id = str(uuid.uuid4())
    url = star_assets.save(star_id, asset_id, data, detected[1])
    asset = StarAsset(
        id=asset_id, star_id=star_id, kind=kind, name=name, emoji=(emoji or None) if kind == "sound" else None,
        url=url, mime=detected[0], size=len(data), created_by=current_user.id,
    )
    db.add(asset)
    await db.commit()
    await _assets_event(db, star_id)
    return asset


@router.delete("/{star_id}/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(star_id: str, asset_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    asset = (
        await db.execute(select(StarAsset).where(StarAsset.id == asset_id, StarAsset.star_id == star_id))
    ).scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Не найдено")
    url = asset.url
    await db.delete(asset)
    await db.commit()
    star_assets.delete(url)
    await _assets_event(db, star_id)


# --- Звуковая панель -----------------------------------------------------------

# Один звук от человека — не чаще, чем раз в столько секунд.
SOUND_COOLDOWN_SEC = 2.5
_last_sound: dict[str, float] = {}


class PlaySoundBody(BaseModel):
    # id звука Звезды или «builtin:tada».
    sound: str = Field(max_length=64)


@router.post("/{star_id}/planets/{channel_id}/sound", status_code=status.HTTP_204_NO_CONTENT)
async def play_sound(star_id: str, channel_id: str, body: PlaySoundBody, current_user: CurrentUser, db: Db):
    """Звук слышат все, кто сейчас на этой Планете (играет у каждого, не через микрофон)."""
    star, me = await _load_membership(db, star_id, current_user.id)
    if not star.soundboard:
        raise _forbid("Звуковая панель в этой Звезде выключена")
    assert_can_post(star, me)
    if channel_id not in voice.channels_with_user(star_id, current_user.id):
        raise HTTPException(status_code=409, detail="Звуки — только для тех, кто на Планете")
    now = time.monotonic()
    if now - _last_sound.get(current_user.id, 0.0) < SOUND_COOLDOWN_SEC:
        raise HTTPException(status_code=429, detail="Не так часто")

    if body.sound.startswith("builtin:"):
        key = body.sound.removeprefix("builtin:")
        if key not in BUILTIN_SOUNDS:
            raise HTTPException(status_code=404, detail="Звук не найден")
        url, name = f"/sounds/board/{key}.wav", BUILTIN_SOUNDS[key][0]
    else:
        asset = (
            await db.execute(
                select(StarAsset).where(StarAsset.id == body.sound, StarAsset.star_id == star_id, StarAsset.kind == "sound")
            )
        ).scalar_one_or_none()
        if not asset:
            raise HTTPException(status_code=404, detail="Звук не найден")
        url, name = asset.url, asset.name
    _last_sound[current_user.id] = now
    listeners = [p.user_id for p in voice.participants(channel_id)]
    await manager.broadcast_to_users(
        listeners,
        {"type": "star_sound", "star_id": star_id, "channel_id": channel_id, "url": url, "name": name, "by": current_user.id},
    )

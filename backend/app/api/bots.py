"""Боты Звёзд: настройка (право «Каналы»), Bot API по токену и нажатия кнопок.

Bot API — /bot-api/…, заголовок Authorization: Bearer qzb.<id>.<secret>. Бот видит и пишет
только в Спутники своей Звезды. События (новые сообщения, нажатия кнопок) уходят POST'ом на
events_url с подписью — app/core/bots.py. Описание для разработчиков — docs/bots.md.
"""

import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import (
    _broadcast,
    _load_membership,
    _messages_out,
    _require_perm,
    _satellite,
    _star_message,
    bot_targets,
)
from app.core import bots, markup, notify, star_audit
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.link_preview import Blocked
from app.core.stars import Perm
from app.models.star import Star, StarBot, StarChannel, StarMember, StarMessage
from app.models.user import User
from app.schemas.star import BotButton, StarMessageOut

router = APIRouter(prefix="/stars", tags=["bots"])
api_router = APIRouter(prefix="/bot-api", tags=["bot-api"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

MAX_BOTS = 10
MAX_BUTTONS = 5
RATE = 30  # сообщений и правок в минуту на бота
_recent: dict[str, deque[float]] = defaultdict(deque)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- Настройка ботов -------------------------------------------------------------


class BotOut(BaseModel):
    id: str
    name: str
    events_url: str | None
    message_events: bool
    created_at: datetime
    last_used_at: datetime | None
    last_error: str | None

    model_config = {"from_attributes": True}


class BotSecrets(BaseModel):
    """Показываются один раз — при создании и при перевыпуске."""

    bot: BotOut
    token: str
    signing_secret: str


class BotBody(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    events_url: str | None = Field(default=None, max_length=2000)
    message_events: bool = True

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Пустое имя")
        return v

    @field_validator("events_url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        if not v:
            return None
        if not v.startswith(("http://", "https://")):
            raise ValueError("Адрес событий — http:// или https://")
        return v


async def _checked_url(url: str | None) -> None:
    if not url:
        return
    try:
        await bots.check_events_url(url)
    except Blocked as exc:
        raise HTTPException(status_code=422, detail=f"Адрес событий не подходит: {exc}") from None


async def _bot(db: AsyncSession, star_id: str, bot_id: str) -> StarBot:
    bot = (await db.execute(select(StarBot).where(StarBot.id == bot_id, StarBot.star_id == star_id))).scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Бот не найден")
    return bot


@router.get("/{star_id}/bots", response_model=list[BotOut])
async def list_bots(star_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    rows = await db.execute(select(StarBot).where(StarBot.star_id == star_id).order_by(StarBot.created_at))
    # Явно схемой: токен и секрет подписи сюда не попадают.
    return [BotOut.model_validate(b) for b in rows.scalars()]


@router.post("/{star_id}/bots", response_model=BotSecrets, status_code=status.HTTP_201_CREATED)
async def create_bot(star_id: str, body: BotBody, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    count = (await db.execute(select(func.count()).select_from(StarBot).where(StarBot.star_id == star_id))).scalar_one()
    if count >= MAX_BOTS:
        raise HTTPException(status_code=409, detail=f"Не больше {MAX_BOTS} ботов в Звезде")
    await _checked_url(body.events_url)
    bot = StarBot(star_id=star_id, created_by=current_user.id, token_hash="", signing_secret="", **body.model_dump())
    db.add(bot)
    await db.flush()
    token, token_hash = bots.new_token(bot.id)
    bot.token_hash = token_hash
    bot.signing_secret = secrets.token_urlsafe(32)
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "bot", bot.id, op="create", name=bot.name)
    return BotSecrets(bot=BotOut.model_validate(bot), token=token, signing_secret=bot.signing_secret)


@router.patch("/{star_id}/bots/{bot_id}", response_model=BotOut)
async def update_bot(star_id: str, bot_id: str, body: BotBody, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    bot = await _bot(db, star_id, bot_id)
    await _checked_url(body.events_url)
    for key, value in body.model_dump().items():
        setattr(bot, key, value)
    bot.last_error = None
    await db.commit()
    return BotOut.model_validate(bot)


@router.post("/{star_id}/bots/{bot_id}/secrets", response_model=BotSecrets)
async def reissue_secrets(star_id: str, bot_id: str, current_user: CurrentUser, db: Db):
    """Новый токен и секрет подписи — старые сразу перестают работать."""
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    bot = await _bot(db, star_id, bot_id)
    token, bot.token_hash = bots.new_token(bot.id)
    bot.signing_secret = secrets.token_urlsafe(32)
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "bot", bot.id, op="secrets", name=bot.name)
    return BotSecrets(bot=BotOut.model_validate(bot), token=token, signing_secret=bot.signing_secret)


@router.delete("/{star_id}/bots/{bot_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bot(star_id: str, bot_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    bot = await _bot(db, star_id, bot_id)
    name = bot.name
    await db.delete(bot)
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "bot", bot_id, op="delete", name=name)


# --- Bot API -----------------------------------------------------------------------


async def current_bot(db: Db, authorization: Annotated[str | None, Header()] = None) -> StarBot:
    scheme, _, token = (authorization or "").partition(" ")
    parsed = bots.parse_token(token) if scheme.lower() == "bearer" else None
    bot = await db.get(StarBot, parsed[0]) if parsed else None
    if not bot or not bots.token_matches(parsed[1], bot.token_hash):
        raise HTTPException(status_code=401, detail="Неверный токен бота", headers={"WWW-Authenticate": "Bearer"})
    return bot


CurrentBot = Annotated[StarBot, Depends(current_bot)]


def _rate(bot: StarBot) -> None:
    now = time.monotonic()
    recent = _recent[bot.id]
    while recent and now - recent[0] > 60:
        recent.popleft()
    if len(recent) >= RATE:
        raise HTTPException(status_code=429, detail=f"Не больше {RATE} сообщений и правок в минуту")
    recent.append(now)


async def _bot_channel(db: AsyncSession, bot: StarBot, channel_id: str) -> StarChannel:
    """Спутник Звезды бота (общие Спутники других Звёзд боту не доступны)."""
    channel = (
        await db.execute(
            select(StarChannel).where(
                StarChannel.id == channel_id, StarChannel.star_id == bot.star_id, StarChannel.kind == "satellite"
            )
        )
    ).scalar_one_or_none()
    if not channel:
        raise HTTPException(status_code=404, detail="Спутник не найден")
    return channel


def _buttons(raw: list[BotButton] | None) -> list[dict] | None:
    if raw is None:
        return None
    if len(raw) > MAX_BUTTONS:
        raise HTTPException(status_code=422, detail=f"Не больше {MAX_BUTTONS} кнопок")
    if len({b.id for b in raw}) != len(raw):
        raise HTTPException(status_code=422, detail="У кнопок должны быть разные id")
    return [b.model_dump() for b in raw]


async def _mentions(db: AsyncSession, star_id: str, text: str) -> list[str]:
    """@имя участников Звезды (без @все и групп — это для людей)."""
    if "@" not in text:
        return []
    names = dict(
        (
            await db.execute(
                select(func.lower(User.username), User.id)
                .join(StarMember, StarMember.user_id == User.id)
                .where(StarMember.star_id == star_id)
            )
        ).all()
    )
    return sorted(notify.find_mentions(text, names).ids)


class BotMe(BaseModel):
    id: str
    name: str
    star_id: str
    star_name: str


class ChannelBrief(BaseModel):
    id: str
    name: str
    announcement: bool


class BotSend(BaseModel):
    text: str = Field(min_length=1, max_length=rules.MAX_MESSAGE_LENGTH)
    thread_id: str | None = None
    reply_to_id: str | None = None
    buttons: list[BotButton] | None = None


class BotEdit(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=rules.MAX_MESSAGE_LENGTH)
    # [] — убрать кнопки, null — не трогать.
    buttons: list[BotButton] | None = None


@api_router.get("/me", response_model=BotMe)
async def bot_me(bot: CurrentBot, db: Db):
    star = await db.get(Star, bot.star_id)
    return BotMe(id=bot.id, name=bot.name, star_id=bot.star_id, star_name=star.name if star else "")


@api_router.get("/channels", response_model=list[ChannelBrief])
async def bot_channels(bot: CurrentBot, db: Db):
    rows = await db.execute(
        select(StarChannel)
        .where(StarChannel.star_id == bot.star_id, StarChannel.kind == "satellite")
        .order_by(StarChannel.position, StarChannel.created_at)
    )
    return [ChannelBrief(id=c.id, name=c.name, announcement=c.announcement) for c in rows.scalars()]


@api_router.get("/channels/{channel_id}/messages", response_model=list[StarMessageOut])
async def bot_messages(channel_id: str, bot: CurrentBot, db: Db, limit: int = Query(20, ge=1, le=100)):
    await _bot_channel(db, bot, channel_id)
    rows = (
        await db.execute(
            select(StarMessage, User)
            .outerjoin(User, User.id == StarMessage.sender_id)
            .where(StarMessage.channel_id == channel_id, StarMessage.thread_id.is_(None))
            .order_by(StarMessage.created_at.desc())
            .limit(limit)
        )
    ).all()
    return await _messages_out(db, [(m, u) for m, u in reversed(rows)])


@api_router.post("/channels/{channel_id}/messages", response_model=StarMessageOut, status_code=status.HTTP_201_CREATED)
async def bot_send(channel_id: str, body: BotSend, bot: CurrentBot, db: Db):
    channel = await _bot_channel(db, bot, channel_id)
    _rate(bot)
    for ref in (body.thread_id, body.reply_to_id):
        if ref:
            target = await db.get(StarMessage, ref)
            if not target or target.channel_id != channel_id or (ref == body.thread_id and target.thread_id):
                raise HTTPException(status_code=422, detail="Сообщение для ответа или ветки не найдено")
    message = StarMessage(
        star_id=bot.star_id,
        channel_id=channel_id,
        sender_id=None,
        text=body.text,
        kind="bot",
        bot_id=bot.id,
        bot_name=bot.name,
        bot_kind="bot",
        thread_id=body.thread_id,
        reply_to_id=body.reply_to_id,
        buttons=_buttons(body.buttons),
        mentions=await _mentions(db, bot.star_id, body.text),
    )
    bot.last_used_at = _now()
    db.add(message)
    await db.commit()
    out = (await _messages_out(db, [(message, None)]))[0]
    await _broadcast(db, bot.star_id, {"type": "star_message", "message": out.model_dump(mode="json")})
    if message.thread_id:
        from app.api.stars import thread_event

        await thread_event(db, bot.star_id, channel_id, message.thread_id)
    star = await db.get(Star, bot.star_id)
    targets = await notify.star_push_targets(db, star, channel, message)
    notify.push_later(
        targets,
        {
            "type": "star_message",
            "title": f"{bot.name} · #{channel.name} · {star.name}",
            "body": markup.plain_text(body.text)[:200],
            "star_id": star.id,
            "channel_id": channel.id,
            "message_id": message.id,
            "tag": f"quazar-star-{channel.id}",
        },
    )
    # Другим ботам Звезды — как обычное новое сообщение.
    bots.dispatch_later(await bot_targets(db, channel, exclude_bot_id=bot.id), out.model_dump(mode="json"))
    return out


async def _own_message(db: AsyncSession, bot: StarBot, message_id: str) -> StarMessage:
    message = await db.get(StarMessage, message_id)
    if not message or message.bot_id != bot.id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено — бот правит только свои")
    return message


async def apply_edit(db: AsyncSession, message: StarMessage, text: str | None, buttons: list[dict] | None) -> StarMessageOut:
    """Обновить текст и/или кнопки сообщения бота и разослать правку."""
    if text is not None and text != message.text:
        message.text = text
        message.mentions = await _mentions(db, message.star_id, text)
        message.edited_at = _now()
    if buttons is not None:
        message.buttons = buttons
    await db.commit()
    await _broadcast(
        db,
        message.star_id,
        {
            "type": "star_message_edited",
            "channel_id": message.channel_id,
            "message_id": message.id,
            "text": message.text,
            "edited_at": message.edited_at.isoformat() if message.edited_at else None,
            "mentions": message.mentions or [],
            "mention_all": False,
            "buttons": message.buttons or [],
        },
    )
    return (await _messages_out(db, [(message, None)]))[0]


@api_router.patch("/messages/{message_id}", response_model=StarMessageOut)
async def bot_edit(message_id: str, body: BotEdit, bot: CurrentBot, db: Db):
    message = await _own_message(db, bot, message_id)
    _rate(bot)
    return await apply_edit(db, message, body.text, _buttons(body.buttons))


@api_router.delete("/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def bot_delete(message_id: str, bot: CurrentBot, db: Db):
    message = await _own_message(db, bot, message_id)
    channel_id, root_id = message.channel_id, message.thread_id
    await db.delete(message)
    await db.commit()
    await _broadcast(db, bot.star_id, {"type": "star_message_deleted", "channel_id": channel_id, "message_id": message_id})
    if root_id:
        from app.api.stars import thread_event

        await thread_event(db, bot.star_id, channel_id, root_id)


# --- Нажатие кнопки ----------------------------------------------------------------


class PressOut(BaseModel):
    # Короткий ответ боту нажавшему (всплывашка), если бот его прислал.
    notice: str | None = None


class _BotReply(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=rules.MAX_MESSAGE_LENGTH)
    buttons: list[BotButton] | None = None
    notice: str | None = Field(default=None, max_length=200)


@router.post(
    "/{star_id}/channels/{channel_id}/messages/{message_id}/buttons/{button_id}", response_model=PressOut
)
async def press_button(star_id: str, channel_id: str, message_id: str, button_id: str, current_user: CurrentUser, db: Db):
    """Нажатие кнопки под сообщением бота — событие button боту; ответом он может сразу
    обновить сообщение ({"text", "buttons"}) и показать нажавшему {"notice"}."""
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    message = await _star_message(db, star_id, channel_id, message_id)
    if not message.bot_id or not any(b.get("id") == button_id for b in (message.buttons or [])):
        raise HTTPException(status_code=404, detail="Кнопка не найдена")
    bot = await db.get(StarBot, message.bot_id)
    if not bot or not bot.events_url:
        raise HTTPException(status_code=409, detail="Бот не принимает нажатия — у него не указан адрес событий")
    event: dict[str, Any] = {
        "type": "button",
        "bot_id": bot.id,
        "star_id": message.star_id,
        "channel_id": channel_id,
        "message_id": message.id,
        "button_id": button_id,
        "user": {"id": current_user.id, "username": current_user.username, "display_name": current_user.display_name},
        "sent_at": _now().isoformat(),
    }
    try:
        reply = await bots.deliver(bot.events_url, bot.signing_secret, event)
        bot.last_error = None
    except bots.DeliveryError as exc:
        bot.last_error = str(exc)[:200]
        bot.last_used_at = _now()
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Бот не обработал нажатие: {exc}") from None
    bot.last_used_at = _now()
    await db.commit()
    if not reply:
        return PressOut()
    try:
        parsed = _BotReply.model_validate(reply)
    except ValidationError:
        return PressOut()
    if parsed.text is not None or parsed.buttons is not None:
        await apply_edit(db, message, parsed.text, _buttons(parsed.buttons))
    return PressOut(notice=parsed.notice)

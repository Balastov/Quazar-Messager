"""Интеграции: входящие вебхуки в Спутники.

Настраивают те, кто может создавать каналы. Адрес — /hooks/<id>/<token>: токен в адресе и есть
пароль, поэтому его видно только им и его можно перевыпустить.
"""

import json
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _broadcast, _messages_out, _require_perm, _satellite, bot_targets
from app.core import bots, markup, notify, star_audit, webhooks
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.star import Star, StarChannel, StarMessage, StarWebhook
from app.models.user import User

router = APIRouter(prefix="/stars", tags=["stars"])
hooks_router = APIRouter(prefix="/hooks", tags=["hooks"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

MAX_BODY = 256 * 1024
RATE = 30  # сообщений в минуту на вебхук
MAX_PER_STAR = 25
_recent: dict[str, deque[float]] = defaultdict(deque)

Kind = Literal["auto", "github", "gitlab", "jira", "grafana", "alertmanager", "generic"]


class WebhookOut(BaseModel):
    id: str
    channel_id: str
    name: str
    kind: str
    token: str
    created_at: datetime
    last_used_at: datetime | None
    last_error: str | None

    model_config = {"from_attributes": True}


class CreateWebhook(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    kind: Kind = "auto"


class UpdateWebhook(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=48)
    kind: Kind | None = None
    channel_id: str | None = None
    # Перевыпустить адрес: старый перестанет работать.
    new_token: bool = False


@router.get("/{star_id}/webhooks", response_model=list[WebhookOut])
async def list_webhooks(star_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    rows = await db.execute(select(StarWebhook).where(StarWebhook.star_id == star_id).order_by(StarWebhook.created_at))
    return list(rows.scalars())


@router.post("/{star_id}/channels/{channel_id}/webhooks", response_model=WebhookOut, status_code=201)
async def create_webhook(star_id: str, channel_id: str, body: CreateWebhook, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    await _satellite(db, star_id, channel_id)
    count = len((await db.execute(select(StarWebhook.id).where(StarWebhook.star_id == star_id))).all())
    if count >= MAX_PER_STAR:
        raise HTTPException(status_code=409, detail=f"Не больше {MAX_PER_STAR} интеграций в Звезде")
    hook = StarWebhook(
        star_id=star_id,
        channel_id=channel_id,
        name=" ".join(body.name.split()),
        kind=body.kind,
        token=secrets.token_urlsafe(32),
        created_by=current_user.id,
    )
    db.add(hook)
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "webhook", None, op="create", name=hook.name)
    return hook


@router.patch("/{star_id}/webhooks/{webhook_id}", response_model=WebhookOut)
async def update_webhook(star_id: str, webhook_id: str, body: UpdateWebhook, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    hook = await _hook(db, star_id, webhook_id)
    if body.name is not None:
        hook.name = " ".join(body.name.split())
    if body.kind is not None:
        hook.kind = body.kind
    if body.channel_id is not None:
        await _satellite(db, star_id, body.channel_id)
        hook.channel_id = body.channel_id
    if body.new_token:
        hook.token = secrets.token_urlsafe(32)
    await db.commit()
    return hook


@router.delete("/{star_id}/webhooks/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_webhook(star_id: str, webhook_id: str, current_user: CurrentUser, db: Db):
    await _require_perm(db, star_id, current_user, Perm.MANAGE_CHANNELS)
    hook = await _hook(db, star_id, webhook_id)
    name = hook.name
    await db.delete(hook)
    await db.commit()
    await star_audit.record(db, star_id, current_user.id, "webhook", None, op="delete", name=name)


async def _hook(db: AsyncSession, star_id: str, webhook_id: str) -> StarWebhook:
    hook = (
        await db.execute(select(StarWebhook).where(StarWebhook.id == webhook_id, StarWebhook.star_id == star_id))
    ).scalar_one_or_none()
    if not hook:
        raise HTTPException(status_code=404, detail="Интеграция не найдена")
    return hook


# --- Приём событий --------------------------------------------------------------------


@hooks_router.post("/{webhook_id}/{token}")
async def receive(webhook_id: str, token: str, request: Request, db: Db):
    """Событие внешнего сервиса → сообщение в Спутник. Неинтересные события (звёздочка на GitHub,
    промежуточный статус пайплайна) принимаем без сообщения, чтобы сервис не считал доставку сбоем."""
    hook = await db.get(StarWebhook, webhook_id) if len(webhook_id) <= 36 else None
    if not hook or not secrets.compare_digest(hook.token.encode(), token.encode()):
        raise HTTPException(status_code=404, detail="Not found")

    now = time.monotonic()
    recent = _recent[hook.id]
    while recent and now - recent[0] > 60:
        recent.popleft()
    if len(recent) >= RATE:
        raise HTTPException(status_code=429, detail="Too many requests")
    recent.append(now)

    raw = bytearray()
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY:
            raise HTTPException(status_code=413, detail="Body too large")
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        # Не JSON — считаем простым текстом.
        body = {"text": raw.decode("utf-8", errors="replace")}

    hook.last_used_at = datetime.now(timezone.utc)
    try:
        text = webhooks.render(hook.kind, dict(request.headers), body)
    except webhooks.Unsupported as exc:
        hook.last_error = str(exc)[:200]
        await db.commit()
        if hook.kind == "generic" or (hook.kind == "auto" and webhooks.detect(dict(request.headers), body) == "generic"):
            raise HTTPException(status_code=422, detail=str(exc)) from None
        return {"ok": True, "posted": False, "reason": str(exc)}
    hook.last_error = None

    service = hook.kind if hook.kind != "auto" else webhooks.detect(dict(request.headers), body)
    message = StarMessage(
        star_id=hook.star_id,
        channel_id=hook.channel_id,
        sender_id=None,
        text=text,
        kind="bot",
        webhook_id=hook.id,
        bot_name=hook.name,
        bot_kind=service,
    )
    db.add(message)
    await db.commit()
    out = (await _messages_out(db, [(message, None)]))[0]
    await _broadcast(db, hook.star_id, {"type": "star_message", "message": out.model_dump(mode="json")})

    star = await db.get(Star, hook.star_id)
    channel = await db.get(StarChannel, hook.channel_id)
    bots.dispatch_later(await bot_targets(db, channel), out.model_dump(mode="json"))
    targets = await notify.star_push_targets(db, star, channel, message)
    notify.push_later(
        targets,
        {
            "type": "star_message",
            "title": f"{hook.name} · #{channel.name} · {star.name}",
            "body": markup.plain_text(text)[:200],
            "star_id": star.id,
            "channel_id": channel.id,
            "message_id": message.id,
            "tag": f"quazar-star-{channel.id}",
        },
    )
    return {"ok": True, "posted": True, "message_id": message.id}

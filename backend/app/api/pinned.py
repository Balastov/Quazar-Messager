"""Закреплённые в списках чаты и контакты — на аккаунт, чтобы на телефоне и компьютере были одни и те же.
(Закреплённые сообщения — другое, см. app.api.pins.)

«Записная книжка» закреплена всегда и в лимит не входит, поэтому закрепить её нельзя.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.chat import Chat, ChatMember
from app.models.user import User
from app.ws.hub import manager

router = APIRouter(prefix="/users/me/pinned", tags=["pinned"])
CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

PIN_LIMIT = 5
PREMIUM_PIN_LIMIT = 10
Kind = Literal["chats", "contacts"]


class Pins(BaseModel):
    # Сверху — закреплённый последним.
    chats: list[str] = []
    contacts: list[str] = []
    limit: int = PIN_LIMIT
    # Растёт с каждым изменением: событие с другого устройства может прийти позже свежего ответа.
    rev: int = 0


def pin_limit(user: User) -> int:
    return PREMIUM_PIN_LIMIT if user.is_premium else PIN_LIMIT


def _out(user: User) -> Pins:
    pins = user.pins or {}
    return Pins(chats=list(pins.get("chats") or []), contacts=list(pins.get("contacts") or []), limit=pin_limit(user),
        rev=int(pins.get("rev") or 0))


async def _locked(db: AsyncSession, user_id: str) -> User:
    # populate_existing: пользователь уже загружен в эту сессию (авторизация) — без него под блокировкой
    # остались бы старые значения, и два закрепления подряд затёрли бы друг друга.
    query = select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True)
    return (await db.execute(query)).scalar_one()


@router.get("", response_model=Pins)
async def list_pins(current_user: CurrentUser, db: Db):
    user = (await db.execute(select(User).where(User.id == current_user.id))).scalar_one()
    return _out(user)


@router.put("/{kind}/{target_id}", response_model=Pins)
async def pin(kind: Kind, target_id: str, current_user: CurrentUser, db: Db):
    if kind == "chats":
        chat_type = (
            await db.execute(
                select(Chat.type)
                .join(ChatMember, ChatMember.chat_id == Chat.id)
                .where(Chat.id == target_id, ChatMember.user_id == current_user.id)
            )
        ).scalar_one_or_none()
        if chat_type is None:
            raise HTTPException(status_code=404, detail="Чат не найден")
        if chat_type == "saved":
            raise HTTPException(status_code=400, detail="«Записная книжка» и так всегда сверху")
    else:
        if target_id == current_user.id:
            raise HTTPException(status_code=400, detail="Себя закреплять не нужно — есть «Записная книжка»")
        if (await db.execute(select(User.id).where(User.id == target_id))).scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")

    user = await _locked(db, current_user.id)
    pins = dict(user.pins or {})
    ids = list(pins.get(kind) or [])
    if target_id in ids:
        return _out(user)
    limit = pin_limit(user)
    if len(ids) >= limit:
        what = "чатов" if kind == "chats" else "контактов"
        more = "" if user.is_premium else f" С Quazar Premium — до {PREMIUM_PIN_LIMIT}."
        raise HTTPException(status_code=409, detail=f"Закрепить можно до {limit} {what}.{more}")
    pins[kind] = [target_id, *ids]
    pins["rev"] = int(pins.get("rev") or 0) + 1
    user.pins = pins
    await db.commit()
    out = _out(user)
    await manager.send_to_user(user.id, {"type": "pins_changed", "pins": out.model_dump()})
    return out


@router.delete("/{kind}/{target_id}", response_model=Pins)
async def unpin(kind: Kind, target_id: str, current_user: CurrentUser, db: Db):
    user = await _locked(db, current_user.id)
    pins = dict(user.pins or {})
    ids = list(pins.get(kind) or [])
    if target_id in ids:
        pins[kind] = [i for i in ids if i != target_id]
        pins["rev"] = int(pins.get("rev") or 0) + 1
        user.pins = pins
        await db.commit()
        out = _out(user)
        await manager.send_to_user(user.id, {"type": "pins_changed", "pins": out.model_dump()})
        return out
    return _out(user)

"""Контакты из телефонной книги: сверка с пользователями Quazar, видны на всех устройствах.

Клиент присылает имена и номера. Сервер сверяет номера с пользователями Quazar, сохраняет
только найденных (и имя, под которым они записаны) и забывает остальное.

- replace — книга целиком (мобильное приложение): прежний список заменяется;
- merge — часть книги (PWA: выбор контактов на Android, файл .vcf): найденные добавляются.
"""

import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.phone import normalize_ru_phone
from app.models.contact import ContactSync, UserContact
from app.models.user import User
from app.schemas.user import UserOut
from app.ws.hub import manager

router = APIRouter(prefix="/contacts", tags=["contacts"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

MAX_CONTACTS = 5000
MAX_PHONES_PER_CONTACT = 10
# Сверка книги — не способ перебирать номера: не чаще нескольких раз в час.
SYNC_LIMIT_PER_HOUR = 10
_recent_syncs: dict[str, deque[float]] = defaultdict(deque)


class PhonebookEntry(BaseModel):
    name: str = Field(default="", max_length=256)
    phones: list[str] = Field(default_factory=list, max_length=MAX_PHONES_PER_CONTACT)


class SyncIn(BaseModel):
    contacts: list[PhonebookEntry] = Field(max_length=MAX_CONTACTS)
    mode: Literal["replace", "merge"] = "replace"


class ContactOut(BaseModel):
    user: UserOut
    name: str


class ContactsOut(BaseModel):
    synced_at: datetime | None
    total: int
    contacts: list[ContactOut]


def _check_rate(user_id: str) -> None:
    now = time.monotonic()
    recent = _recent_syncs[user_id]
    while recent and now - recent[0] > 3600:
        recent.popleft()
    if len(recent) >= SYNC_LIMIT_PER_HOUR:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Контакты обновлялись слишком часто — попробуйте позже",
        )
    recent.append(now)


def _phonebook_names(entries: list[PhonebookEntry]) -> dict[str, str]:
    """Нормализованный номер → имя из книги. Чужие страны и мусор пропускаем."""
    names: dict[str, str] = {}
    for entry in entries:
        name = " ".join(entry.name.split())[:128]
        for raw in entry.phones:
            try:
                phone = normalize_ru_phone(raw)
            except ValueError:
                continue
            names.setdefault(phone, name)
    return names


async def _contacts_out(db: AsyncSession, user_id: str) -> ContactsOut:
    rows = (
        await db.execute(
            select(UserContact, User)
            .join(User, User.id == UserContact.contact_id)
            .where(UserContact.owner_id == user_id, User.is_active.is_(True))
        )
    ).all()
    sync = await db.get(ContactSync, user_id)
    contacts = [
        ContactOut(user=UserOut.model_validate(user), name=contact.name or user.username)
        for contact, user in rows
    ]
    contacts.sort(key=lambda c: c.name.lower())
    return ContactsOut(
        synced_at=sync.synced_at if sync else None, total=sync.total if sync else 0, contacts=contacts
    )


@router.get("", response_model=ContactsOut)
async def my_contacts(current_user: CurrentUser, db: Db):
    return await _contacts_out(db, current_user.id)


@router.post("/sync", response_model=ContactsOut)
async def sync_contacts(body: SyncIn, current_user: CurrentUser, db: Db):
    """replace: найденные заменяют прежний список (удалённые из книги уходят); merge: добавляются."""
    _check_rate(current_user.id)
    names = _phonebook_names(body.contacts)
    found = []
    if names:
        found = (
            (
                await db.execute(
                    select(User).where(
                        User.phone.in_(names), User.id != current_user.id, User.is_active.is_(True)
                    )
                )
            )
            .scalars()
            .all()
        )

    if body.mode == "replace":
        await db.execute(delete(UserContact).where(UserContact.owner_id == current_user.id))
        existing: dict[str, UserContact] = {}
    else:
        existing = {
            c.contact_id: c
            for c in (
                await db.execute(select(UserContact).where(UserContact.owner_id == current_user.id))
            ).scalars()
        }
    for user in found:
        name = names[user.phone]
        if user.id in existing:
            # Переименовали в книге — обновляем; без имени старое не затираем.
            if name:
                existing[user.id].name = name
        else:
            db.add(UserContact(owner_id=current_user.id, contact_id=user.id, name=name))
    sync = await db.get(ContactSync, current_user.id)
    now = datetime.now(timezone.utc)
    # total — сколько контактов книги сверено: при merge копится.
    total = len(body.contacts) + (sync.total if sync and body.mode == "merge" else 0)
    if sync:
        sync.synced_at, sync.total = now, total
    else:
        db.add(ContactSync(user_id=current_user.id, synced_at=now, total=total))
    await db.commit()

    # Открытый на компьютере веб обновит список сам.
    await manager.send_to_user(current_user.id, {"type": "contacts_updated"})
    return await _contacts_out(db, current_user.id)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def forget_contacts(current_user: CurrentUser, db: Db):
    """Отключили синхронизацию — стираем найденные контакты с сервера."""
    await db.execute(delete(UserContact).where(UserContact.owner_id == current_user.id))
    await db.execute(delete(ContactSync).where(ContactSync.user_id == current_user.id))
    await db.commit()
    await manager.send_to_user(current_user.id, {"type": "contacts_updated"})

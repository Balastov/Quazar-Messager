"""Заметки Спутника: вики-страница в markdown с историей правок.

Читают все участники Звезды. Правит тот, кто может писать в Спутник (в канал объявлений —
модераторы и выше). Сохраняют с base_version — версией, от которой начинали правку: если
кто-то успел сохранить раньше, ответ 409 с актуальной версией, и клиент предлагает сверить.
Каждая правка — новая версия в истории; хранятся последние NOTE_REVISIONS.
"""

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _broadcast, _forbid, _load_membership, _satellite, _staff_here, _user_out, assert_can_post
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.star import StarChannelNote, StarChannelNoteRevision
from app.models.user import User
from app.schemas.star import StarUserOut

router = APIRouter(prefix="/stars", tags=["stars"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

NOTE_MAX_CHARS = 100_000
NOTE_REVISIONS = 100


class NoteOut(BaseModel):
    channel_id: str
    text: str
    # 0 — заметок ещё не было.
    version: int
    updated_by: StarUserOut | None
    updated_at: datetime | None
    can_edit: bool


class SaveNote(BaseModel):
    text: str = Field(max_length=NOTE_MAX_CHARS)
    # Версия, от которой правили (из NoteOut.version).
    base_version: int = Field(ge=0)


class RevisionOut(BaseModel):
    version: int
    author: StarUserOut | None
    created_at: datetime
    # Сколько символов в этой версии — чтобы видеть крупные правки в списке.
    length: int


class RevisionTextOut(RevisionOut):
    text: str


def _can_edit(channel, me) -> bool:
    return not channel.announcement or _staff_here(me, channel)


async def _users(db: AsyncSession, ids: set[str | None]) -> dict[str, StarUserOut]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: _user_out(u) for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars()}


async def _note_out(db: AsyncSession, channel, me) -> NoteOut:
    note = await db.get(StarChannelNote, channel.id)
    users = await _users(db, {note.updated_by if note else None})
    return NoteOut(
        channel_id=channel.id,
        text=note.text if note else "",
        version=note.version if note else 0,
        updated_by=users.get(note.updated_by) if note and note.updated_by else None,
        updated_at=note.updated_at if note else None,
        can_edit=_can_edit(channel, me),
    )


@router.get("/{star_id}/channels/{channel_id}/notes", response_model=NoteOut)
async def get_notes(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    _, me = await _load_membership(db, star_id, current_user.id)
    channel = await _satellite(db, star_id, channel_id)
    return await _note_out(db, channel, me)


@router.put("/{star_id}/channels/{channel_id}/notes", response_model=NoteOut)
async def save_notes(star_id: str, channel_id: str, body: SaveNote, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _satellite(db, star_id, channel_id)
    assert_can_post(star, me)
    if not _can_edit(channel, me):
        raise _forbid("Заметки канала объявлений правят модераторы и выше")
    note = (
        await db.execute(select(StarChannelNote).where(StarChannelNote.channel_id == channel_id).with_for_update())
    ).scalar_one_or_none()
    current = note.version if note else 0
    if body.base_version != current:
        # Кто-то сохранил раньше: отдаём актуальное, клиент покажет и предложит сверить.
        latest = await _note_out(db, channel, me)
        await db.rollback()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={
                "detail": "Пока вы правили, заметки изменили. Сверьте с новой версией.",
                "note": latest.model_dump(mode="json"),
            },
        )
    text = body.text.replace("\r\n", "\n")
    if note and note.text == text:
        return await _note_out(db, channel, me)
    now = datetime.now(timezone.utc)
    if not note:
        note = StarChannelNote(channel_id=channel_id, star_id=channel.star_id, version=0)
        db.add(note)
    note.text = text
    note.version = current + 1
    note.updated_by = current_user.id
    note.updated_at = now
    db.add(
        StarChannelNoteRevision(
            channel_id=channel_id, star_id=channel.star_id, version=note.version, text=text,
            author_id=current_user.id, created_at=now,
        )
    )
    try:
        await db.flush()
    except IntegrityError:
        # Первую версию одновременно сохранили двое — второй сверяет, как при любом конфликте.
        await db.rollback()
        raise HTTPException(status_code=409, detail="Пока вы правили, заметки изменили. Обновите и сверьте.") from None
    await db.execute(
        delete(StarChannelNoteRevision).where(
            StarChannelNoteRevision.channel_id == channel_id,
            StarChannelNoteRevision.version <= note.version - NOTE_REVISIONS,
        )
    )
    await db.commit()
    await _broadcast(
        db,
        star_id,
        {
            "type": "star_notes",
            "channel_id": channel_id,
            "version": note.version,
            "updated_by": current_user.id,
            "updated_at": now.isoformat(),
        },
    )
    return await _note_out(db, channel, me)


@router.get("/{star_id}/channels/{channel_id}/notes/revisions", response_model=list[RevisionOut])
async def list_revisions(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    rows = (
        await db.execute(
            select(StarChannelNoteRevision)
            .where(StarChannelNoteRevision.channel_id == channel_id)
            .order_by(StarChannelNoteRevision.version.desc())
        )
    ).scalars().all()
    users = await _users(db, {r.author_id for r in rows})
    return [
        RevisionOut(version=r.version, author=users.get(r.author_id or ""), created_at=r.created_at, length=len(r.text))
        for r in rows
    ]


@router.get("/{star_id}/channels/{channel_id}/notes/revisions/{version}", response_model=RevisionTextOut)
async def get_revision(star_id: str, channel_id: str, version: int, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    await _satellite(db, star_id, channel_id)
    rev = (
        await db.execute(
            select(StarChannelNoteRevision).where(
                StarChannelNoteRevision.channel_id == channel_id, StarChannelNoteRevision.version == version
            )
        )
    ).scalar_one_or_none()
    if not rev:
        raise HTTPException(status_code=404, detail="Такой версии нет — старые версии со временем удаляются")
    users = await _users(db, {rev.author_id})
    return RevisionTextOut(
        version=rev.version, author=users.get(rev.author_id or ""), created_at=rev.created_at,
        length=len(rev.text), text=rev.text,
    )

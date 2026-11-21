"""Запись встреч в комнатах рабочих Звёзд: включить, принять куски видео и звука, остановить.

Подробности — app/core/recordings.py.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.star_files import _quota, _used
from app.api.stars import _chat, _forbid, _load_viewer
from app.core import recordings, star_files
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.recording import RoomRecording
from app.models.user import User

router = APIRouter(prefix="/stars", tags=["recordings"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

VIDEO_MIMES = {"video/webm", "video/mp4"}
AUDIO_MIMES = {"audio/webm", "audio/mp4", "audio/ogg"}


class StartRecording(BaseModel):
    # Подпись для имён файлов в местном времени («21.11 14:00»).
    label: str = Field(default="", max_length=40)
    video_mime: str = "video/webm"
    audio_mime: str = "audio/webm"


class StartRecordingOut(BaseModel):
    id: str


@router.post("/{star_id}/planets/{channel_id}/recording", response_model=StartRecordingOut, status_code=201)
async def start_recording(star_id: str, channel_id: str, body: StartRecording, current_user: CurrentUser, db: Db):
    star, me, channel = await _chat(db, star_id, channel_id, current_user.id)
    if channel.kind != "planet":
        raise HTTPException(status_code=400, detail="Записывать можно только встречи в комнатах")
    if star.kind != "work":
        raise _forbid("Записывать встречи можно в комнатах рабочих Звёзд")
    if not recordings.can_record(star, me, channel):
        raise _forbid("Включить запись могут модераторы и главный в комнате")
    if not recordings.inside(channel_id, current_user.id):
        raise HTTPException(status_code=409, detail="Сначала войдите в Комнату")
    if await recordings.active(db, channel_id):
        raise HTTPException(status_code=409, detail="В комнате уже идёт запись")
    try:
        star_files.ensure_free_space()
    except star_files.StorageFull:
        raise HTTPException(status_code=507, detail="На сервере закончилось место — запись не начнётся") from None
    unlimited = current_user.is_superuser or bool(
        (await db.execute(select(User.is_superuser).where(User.id == star.owner_id))).scalar_one_or_none()
    )
    if not unlimited and await _used(db, star_id) + recordings.MIN_QUOTA_LEFT > _quota():
        raise HTTPException(status_code=507, detail="В Звезде почти не осталось места под файлы — удалите старые")
    rec = RoomRecording(
        star_id=star_id, channel_id=channel_id, started_by=current_user.id, label=body.label.strip(),
        video_mime=body.video_mime if body.video_mime in VIDEO_MIMES else "video/webm",
        audio_mime=body.audio_mime if body.audio_mime in AUDIO_MIMES else "audio/webm",
    )
    db.add(rec)
    await db.commit()
    for kind in recordings.KINDS:
        star_files.file_path(recordings.file_id(rec, kind)).touch()
    await recordings.set_flag(star_id, channel_id, current_user.id, True)
    return StartRecordingOut(id=rec.id)


async def _own_recording(db: AsyncSession, star_id: str, rec_id: str, user_id: str) -> RoomRecording:
    rec = (
        await db.execute(select(RoomRecording).where(RoomRecording.id == rec_id).with_for_update())
    ).scalar_one_or_none()
    if not rec or rec.star_id != star_id or rec.started_by != user_id:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    return rec


@router.put("/{star_id}/recordings/{rec_id}/{kind}", status_code=status.HTTP_204_NO_CONTENT)
async def upload_chunk(
    star_id: str,
    rec_id: str,
    kind: Literal["video", "audio"],
    request: Request,
    current_user: CurrentUser,
    db: Db,
    seq: int = Query(ge=0, le=1_000_000),
):
    """Кусок записи (сырое тело). Куски идут по порядку; повтор уже принятого — не ошибка."""
    data = await request.body()
    if len(data) > recordings.MAX_CHUNK_BYTES:
        raise HTTPException(status_code=413, detail="Слишком большой кусок записи")
    rec = await _own_recording(db, star_id, rec_id, current_user.id)
    if rec.status != "recording":
        raise HTTPException(status_code=409, detail=_stopped_text(rec, current_user.id))
    if not data:
        return Response(status_code=204)
    try:
        star_files.ensure_free_space()
    except star_files.StorageFull:
        await recordings.finish(db, rec, "storage")
        raise HTTPException(status_code=507, detail="На сервере закончилось место — запись остановлена и сохранена") from None
    try:
        result = await recordings.append_chunk(db, rec, kind, seq, data)
    except ValueError:
        await recordings.finish(db, rec, "limit")
        raise HTTPException(status_code=413, detail="Запись достигла предела размера — она остановлена и сохранена") from None
    if result not in ("ok", "dup"):
        raise HTTPException(status_code=409, detail={"expected": int(result)})
    return Response(status_code=204)


def _stopped_text(rec: RoomRecording, user_id: str) -> str:
    """Почему включивший больше не может дописывать запись."""
    if rec.stopped_by and rec.stopped_by != user_id:
        return "Запись остановил модератор — то, что успело записаться, сохранено в чате комнаты"
    return "Запись уже остановлена"


async def _stop(db: AsyncSession, star_id: str, rec: RoomRecording | None, user_id: str) -> None:
    """Остановить: тот, кто включил, или модератор Звезды (и выше)."""
    _, me = await _load_viewer(db, star_id, user_id)
    if not rec or rec.star_id != star_id:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    if rec.started_by != user_id and not rules.is_staff(me.role):
        raise _forbid("Остановить чужую запись может модератор Звезды")
    if rec.status == "recording":
        rec.stopped_by = user_id
    await recordings.finish(db, rec, "stopped" if rec.started_by == user_id else "stopped by moderator")


@router.post("/{star_id}/recordings/{rec_id}/stop", status_code=status.HTTP_204_NO_CONTENT)
async def stop_recording(star_id: str, rec_id: str, current_user: CurrentUser, db: Db):
    rec = (
        await db.execute(select(RoomRecording).where(RoomRecording.id == rec_id).with_for_update())
    ).scalar_one_or_none()
    await _stop(db, star_id, rec, current_user.id)
    return Response(status_code=204)


@router.post("/{star_id}/planets/{channel_id}/recording/stop", status_code=status.HTTP_204_NO_CONTENT)
async def stop_room_recording(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    """Остановить запись, которая идёт в комнате (модератор — чужую: кто-то забыл про неё или пишет без спроса)."""
    rec = (
        await db.execute(
            select(RoomRecording)
            .where(RoomRecording.channel_id == channel_id, RoomRecording.status == "recording")
            .with_for_update()
        )
    ).scalars().first()
    if not rec:
        raise HTTPException(status_code=404, detail="В комнате сейчас не идёт запись")
    await _stop(db, star_id, rec, current_user.id)
    return Response(status_code=204)

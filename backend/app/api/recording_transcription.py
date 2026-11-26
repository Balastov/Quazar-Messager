"""Запрос и чтение общей расшифровки сохранённой встречи."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import recording_transcription as service, transcription
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.transcription import RecordingTranscript
from app.models.user import User

router = APIRouter(prefix="/stars", tags=["transcription"])
CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


def output(job: RecordingTranscript | None, status_code: int = 200) -> JSONResponse:
    return JSONResponse({
        "enabled": transcription.configured(),
        "status": job.status if job else "idle",
        "text": job.text if job else "",
        "processed_seconds": job.processed_seconds if job else 0,
        "total_seconds": job.total_seconds if job else 0,
        "error": job.error if job else None,
    }, status_code=status_code, headers={"Cache-Control": "no-store"})


@router.get("/{star_id}/recordings/{rec_id}/transcription")
async def get_transcript(star_id: str, rec_id: str, current_user: CurrentUser, db: Db):
    await service.readable_recording(db, star_id, rec_id, current_user.id)
    return output(await db.get(RecordingTranscript, rec_id))


@router.post("/{star_id}/recordings/{rec_id}/transcription")
async def request_transcript(star_id: str, rec_id: str, request: Request, current_user: CurrentUser, db: Db):
    await service.readable_recording(db, star_id, rec_id, current_user.id)
    if not transcription.configured():
        raise HTTPException(503, "Расшифровка пока не настроена")
    if request.headers.get("x-transcription-consent") != "cloudflare":
        raise HTTPException(422, "Подтвердите отправку звука встречи в Cloudflare")
    await db.execute(insert(RecordingTranscript).values(
        recording_id=rec_id, requested_by=current_user.id, status="queued", text="",
        processed_seconds=0, total_seconds=0,
    ).on_conflict_do_nothing(index_elements=[RecordingTranscript.recording_id]))
    job = (await db.execute(select(RecordingTranscript).where(
        RecordingTranscript.recording_id == rec_id,
    ).with_for_update())).scalar_one()
    if job.status == "failed":
        job.status, job.error, job.requested_by = "queued", None, current_user.id
    await db.commit()
    return output(job, 200 if job.status == "ready" else 202)

"""Расшифровка по явному запросу участника чата; ключ вложения серверу не нужен."""
import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.messages import _assert_member
from app.core import attachments, transcription
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.attachment import Attachment
from app.models.user import User

router = APIRouter(tags=["transcription"])
_decoders = asyncio.Semaphore(2)


@router.get("/transcription/status")
async def status(current_user: Annotated[User, Depends(get_current_user)]):
    return {"enabled": transcription.configured()}


@router.post("/chats/{chat_id}/attachments/{attachment_id}/transcribe")
async def transcribe_attachment(
    chat_id: str, attachment_id: str, request: Request,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _assert_member(chat_id, current_user.id, db)
    if not transcription.configured():
        raise HTTPException(503, "Расшифровка пока не настроена")
    attachment = (await db.execute(select(Attachment).where(
        Attachment.id == attachment_id, Attachment.chat_id == chat_id,
        Attachment.message_id.is_not(None),
    ))).scalar_one_or_none()
    if not attachment or not attachments.attachment_path(attachment.id).is_file():
        raise HTTPException(404, "Голосовое уже удалено")
    if request.headers.get("x-transcription-consent") != "cloudflare":
        raise HTTPException(422, "Подтвердите отправку аудио в Cloudflare")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > transcription.MAX_BYTES:
            raise HTTPException(413, "Голосовое должно быть не больше 5 МБ")
    if _decoders.locked():
        raise HTTPException(429, "Сервер обрабатывает другие записи. Попробуйте позже")
    async with _decoders:
        audio, seconds = await run_in_threadpool(transcription.prepare_audio, bytes(data))
    await transcription.reserve_usage(db, current_user.id, seconds)
    text = await transcription.transcribe(audio)
    return JSONResponse({"text": text}, headers={"Cache-Control": "no-store"})

"""Картинки в чатах. Тело загрузки — сырой шифротекст (application/octet-stream)."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.messages import _assert_member
from app.core import attachments
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.attachment import Attachment
from app.models.user import User

router = APIRouter(prefix="/chats/{chat_id}/attachments", tags=["attachments"])


class AttachmentOut(BaseModel):
    id: str
    size: int


@router.post("", response_model=AttachmentOut, status_code=201)
async def upload_attachment(
    chat_id: str,
    request: Request,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _assert_member(chat_id, current_user.id, db)

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > attachments.MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Image must be at most 10 MB")
    try:
        attachments.ensure_free_space()
    except attachments.StorageFull:
        raise HTTPException(status_code=507, detail="Server storage is full") from None

    attachment_id = str(uuid.uuid4())
    try:
        size = await attachments.save_stream(attachment_id, request.stream())
    except attachments.AttachmentTooLarge:
        raise HTTPException(status_code=413, detail="Image must be at most 10 MB") from None
    if size <= attachments.ENCRYPTION_OVERHEAD:
        attachments.delete_file(attachment_id)
        raise HTTPException(status_code=422, detail="Empty file")

    db.add(Attachment(id=attachment_id, chat_id=chat_id, uploader_id=current_user.id, size=size))
    await db.commit()
    return AttachmentOut(id=attachment_id, size=size)


@router.get("/{attachment_id}")
async def download_attachment(
    chat_id: str,
    attachment_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    await _assert_member(chat_id, current_user.id, db)
    attachment = (
        await db.execute(
            select(Attachment).where(Attachment.id == attachment_id, Attachment.chat_id == chat_id)
        )
    ).scalar_one_or_none()
    # 404 — в том числе когда картинка удалена по сроку хранения; клиент так и пишет.
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = attachments.attachment_path(attachment.id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Attachment not found")
    # Содержимое не меняется — клиент может кешировать у себя, но не дольше срока хранения,
    # чтобы удалённое с сервера фото пропадало и с устройств.
    ttl_days = settings.ATTACHMENT_TTL_DAYS or 365
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"Cache-Control": f"private, max-age={ttl_days * 86400}, immutable"},
    )

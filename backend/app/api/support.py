"""Обратная связь: обращения людей (предложения, вопросы, ошибки) и их разбор в «Чёрной дыре».

Сама переписка — в чате поддержки (app.core.support); здесь — создание обращения из формы
и раздел «Обращения» для владельцев ресурса.
"""

from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.admin import AdminUserOut, _user_out
from app.api.chats import _load_chat
from app.core import attachments, support
from app.core.database import get_db
from app.core.deps import get_current_user, get_superuser
from app.models.attachment import Attachment
from app.models.message import Message
from app.models.support import SupportMessage, SupportTicket
from app.models.user import User
from app.schemas.chat import ChatOut
from app.schemas.support import (
    CreateTicket,
    TicketKind,
    TicketOut,
    TicketReply,
    TicketStatusBody,
)
from app.ws.hub import manager

router = APIRouter(prefix="/support", tags=["support"])
admin_router = APIRouter(prefix="/admin/tickets", tags=["admin"], include_in_schema=False)

CurrentUser = Annotated[User, Depends(get_current_user)]
Super = Annotated[User, Depends(get_superuser)]
Db = Annotated[AsyncSession, Depends(get_db)]

TICKETS_PER_DAY = 20


@router.post("/chat", response_model=ChatOut)
async def open_support_chat(current_user: CurrentUser, db: Db):
    """Чат с Quazar_Admin_bot — нужен форме до отправки, чтобы загрузить в него картинки."""
    chat = await support.support_chat(db, current_user)
    return await _load_chat(chat.id, db)


@router.post("/tickets", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
async def create_ticket(body: CreateTicket, current_user: CurrentUser, db: Db):
    since = datetime.now(timezone.utc) - timedelta(days=1)
    recent = (
        await db.execute(
            select(func.count())
            .select_from(SupportTicket)
            .where(SupportTicket.user_id == current_user.id, SupportTicket.created_at > since)
        )
    ).scalar_one()
    if recent >= TICKETS_PER_DAY:
        raise HTTPException(status_code=429, detail="Слишком много обращений — попробуйте завтра")
    return await support.create_ticket(db, current_user, body.kind, body.text, body.images)


# --- «Чёрная дыра» ---------------------------------------------------------------------


class AdminTicketOut(TicketOut):
    author: AdminUserOut | None
    # Сообщения человека, которых команда ещё не видела (не открывала обращение).
    unread: int = 0


class AdminTicketMessage(BaseModel):
    id: str
    # user — автор обращения, bot — ответ команды или служебное сообщение бота.
    sender: Literal["user", "bot"]
    # Кто из команды ответил от имени бота.
    admin: AdminUserOut | None = None
    payload: str
    created_at: datetime


class AdminTicketDetail(AdminTicketOut):
    messages: list[AdminTicketMessage]


async def _ticket(db: AsyncSession, ticket_id: str) -> SupportTicket:
    ticket = await db.get(SupportTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Обращение не найдено")
    return ticket


def _unread_query(ticket_ids: list[str]):
    return (
        select(SupportMessage.ticket_id, func.count())
        .join(Message, Message.id == SupportMessage.message_id)
        .join(SupportTicket, SupportTicket.id == SupportMessage.ticket_id)
        .where(
            SupportMessage.ticket_id.in_(ticket_ids),
            Message.sender_id == SupportTicket.user_id,
            Message.status != "read",
        )
        .group_by(SupportMessage.ticket_id)
    )


async def _tickets_out(db: AsyncSession, tickets: list[SupportTicket]) -> list[AdminTicketOut]:
    ids = [t.id for t in tickets]
    users = {
        u.id: _user_out(u)
        for u in (await db.execute(select(User).where(User.id.in_({t.user_id for t in tickets})))).scalars()
    }
    unread = dict((await db.execute(_unread_query(ids))).all()) if ids else {}
    return [
        AdminTicketOut(
            **TicketOut.model_validate(t).model_dump(),
            author=users.get(t.user_id),
            unread=unread.get(t.id, 0),
        )
        for t in tickets
    ]


@admin_router.get("", response_model=list[AdminTicketOut])
async def list_tickets(
    me: Super,
    db: Db,
    status_filter: Literal["open", "all", "queued", "in_progress", "done"] = Query("open", alias="status"),
    kind: TicketKind | None = None,
    limit: int = Query(100, ge=1, le=200),
):
    """Свежие сверху; «open» — всё, что ещё не готово."""
    query = select(SupportTicket)
    if status_filter == "open":
        query = query.where(SupportTicket.status != "done")
    elif status_filter != "all":
        query = query.where(SupportTicket.status == status_filter)
    if kind:
        query = query.where(SupportTicket.kind == kind)
    tickets = list(
        (await db.execute(query.order_by(SupportTicket.updated_at.desc()).limit(limit))).scalars()
    )
    return await _tickets_out(db, tickets)


async def _detail(db: AsyncSession, ticket: SupportTicket) -> AdminTicketDetail:
    rows = (
        await db.execute(
            select(Message, SupportMessage.admin_id)
            .join(SupportMessage, SupportMessage.message_id == Message.id)
            .where(SupportMessage.ticket_id == ticket.id)
            .order_by(Message.created_at)
        )
    ).all()
    admin_ids = {admin_id for _, admin_id in rows if admin_id}
    admins = {
        u.id: _user_out(u)
        for u in (await db.execute(select(User).where(User.id.in_(admin_ids)))).scalars()
    } if admin_ids else {}
    messages = [
        AdminTicketMessage(
            id=m.id,
            sender="user" if m.sender_id == ticket.user_id else "bot",
            admin=admins.get(admin_id) if admin_id else None,
            payload=m.payload,
            created_at=m.created_at,
        )
        for m, admin_id in rows
    ]
    (out,) = await _tickets_out(db, [ticket])
    return AdminTicketDetail(**out.model_dump(), messages=messages)


@admin_router.get("/{ticket_id}", response_model=AdminTicketDetail)
async def get_ticket(ticket_id: str, me: Super, db: Db):
    """Обращение с перепиской. Открыли — сообщения человека прочитаны (у него две зелёные)."""
    ticket = await _ticket(db, ticket_id)
    read_ids = list(
        (
            await db.execute(
                update(Message)
                .where(
                    Message.id.in_(select(SupportMessage.message_id).where(SupportMessage.ticket_id == ticket.id)),
                    Message.sender_id == ticket.user_id,
                    Message.status != "read",
                )
                .values(status="read")
                .returning(Message.id)
            )
        ).scalars()
    )
    await db.commit()
    if read_ids:
        bot = await support.bot_user(db)
        for message_id in read_ids:
            await manager.send_to_user(
                ticket.user_id,
                {"type": "message_status", "message_id": message_id, "status": "read", "updated_by": bot.id},
            )
    return await _detail(db, ticket)


@admin_router.post("/{ticket_id}/reply", response_model=AdminTicketDetail)
async def reply_ticket(ticket_id: str, body: TicketReply, me: Super, db: Db):
    """Ответ человеку — сообщением бота в его чат поддержки."""
    ticket = await _ticket(db, ticket_id)
    await support.bot_says(db, ticket, body.text, admin_id=me.id)
    await support.notify_team(db, ticket)
    return await _detail(db, ticket)


@admin_router.put("/{ticket_id}/status", response_model=AdminTicketDetail)
async def set_ticket_status(ticket_id: str, body: TicketStatusBody, me: Super, db: Db):
    ticket = await _ticket(db, ticket_id)
    await support.set_status(db, ticket, body.status, me)
    return await _detail(db, ticket)


@admin_router.get("/{ticket_id}/attachments/{attachment_id}")
async def ticket_attachment(ticket_id: str, attachment_id: str, me: Super, db: Db):
    """Зашифрованная картинка обращения; ключ — в самом обращении, расшифровывает клиент."""
    ticket = await _ticket(db, ticket_id)
    attachment = (
        await db.execute(
            select(Attachment).where(Attachment.id == attachment_id, Attachment.chat_id == ticket.chat_id)
        )
    ).scalar_one_or_none()
    path = attachments.attachment_path(attachment.id) if attachment else None
    if not path or not path.is_file():
        # Удалена по сроку хранения (30 дней) — клиент так и пишет.
        raise HTTPException(status_code=404, detail="Attachment not found")
    return FileResponse(path, media_type="application/octet-stream")


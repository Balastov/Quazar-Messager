"""Обратная связь: бот Quazar_Admin_bot, чат поддержки и обращения (app.models.support).

- Обращение создаётся формой: в чат поддержки уходит карточка «TKT1:{…}» от имени человека,
  бот отвечает, что принял. Человек может и просто написать боту: сообщение попадёт в открытое
  обращение (или в то, на чью карточку он отвечает), а если открытых нет — станет новым вопросом.
- Команда отвечает из «Чёрной дыры» — сообщением бота. Смена статуса обновляет карточку и
  приходит сообщением бота.
- Чат поддержки не шифруется: обращения читает команда. Клиент предупреждает об этом.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.support import SupportMessage, SupportTicket
from app.models.user import User
from app.ws.hub import manager

if TYPE_CHECKING:
    from app.schemas.support import TicketImage

BOT_USERNAME = "Quazar_Admin_bot"
# Номер-заглушка: не проходит проверку телефона, поэтому войти под ботом нельзя.
BOT_PHONE = "bot:quazar-admin"
TICKET_PREFIX = "TKT1:"
IMAGE_PREFIX = "IMG1:"

KINDS = {"idea": "Предложение", "question": "Вопрос", "bug": "Ошибка"}
STATUSES = {"queued": "В очереди", "in_progress": "В работе", "done": "Готово"}

def _now() -> datetime:
    return datetime.now(timezone.utc)


async def bot_user(db: AsyncSession) -> User:
    """Quazar_Admin_bot; создаётся при первом обращении (и при старте сервера)."""
    bot = (
        await db.execute(select(User).where(User.is_official.is_(True)).order_by(User.created_at).limit(1))
    ).scalar_one_or_none()
    if bot:
        return bot
    bot = User(
        username=BOT_USERNAME,
        phone=BOT_PHONE,
        password_hash=hash_password(secrets.token_urlsafe(32)),
        phone_discoverable=False,
        is_official=True,
    )
    db.add(bot)
    await db.commit()
    return bot


async def support_chat(db: AsyncSession, user: User) -> Chat:
    """Чат человека с ботом — один на человека, создаётся при первом обращении."""
    existing = (
        await db.execute(
            select(Chat)
            .join(ChatMember, ChatMember.chat_id == Chat.id)
            .where(Chat.type == "support", ChatMember.user_id == user.id)
        )
    ).scalar_one_or_none()
    if existing:
        return existing
    bot = await bot_user(db)
    chat = Chat(type="support", name=BOT_USERNAME)
    db.add(chat)
    await db.flush()
    db.add(ChatMember(chat_id=chat.id, user_id=bot.id, role="owner"))
    db.add(ChatMember(chat_id=chat.id, user_id=user.id, role="member"))
    await db.commit()
    return chat


def card_payload(ticket: SupportTicket) -> str:
    """Карточка обращения в чате — открытый JSON: чат поддержки не шифруется."""
    return TICKET_PREFIX + json.dumps(
        {
            "id": ticket.id,
            "number": ticket.number,
            "kind": ticket.kind,
            "text": ticket.text,
            "images": ticket.images or [],
            "status": ticket.status,
        },
        ensure_ascii=False,
    )


def image_ref(payload: str) -> dict | None:
    """Картинка из сообщения «IMG1:{…}» — чтобы показать её в «Чёрной дыре»."""
    if not payload.startswith(IMAGE_PREFIX):
        return None
    try:
        raw = json.loads(payload[len(IMAGE_PREFIX):])
    except ValueError:
        return None
    return raw if isinstance(raw, dict) and isinstance(raw.get("id"), str) else None


async def superuser_ids(db: AsyncSession) -> list[str]:
    return list(
        (
            await db.execute(select(User.id).where(User.is_superuser.is_(True), User.blocked_at.is_(None)))
        ).scalars()
    )


async def notify_team(db: AsyncSession, ticket: SupportTicket) -> None:
    """Открытая «Чёрная дыра» обновляет список обращений."""
    await manager.broadcast_to_users(
        await superuser_ids(db),
        {"type": "support_ticket", "ticket_id": ticket.id, "status": ticket.status},
    )


async def bot_says(
    db: AsyncSession,
    ticket: SupportTicket,
    text: str,
    *,
    admin_id: str | None = None,
) -> Message:
    """Сообщение бота в чат поддержки. Цитирует карточку обращения, только если разговор
    перед этим шёл о другом обращении, — иначе каждая реплика повторяла бы одну и ту же цитату."""
    from app.api.messages import deliver

    chat = await db.get(Chat, ticket.chat_id)
    last_ticket = (
        await db.execute(
            select(SupportMessage.ticket_id)
            .join(Message, Message.id == SupportMessage.message_id)
            .where(Message.chat_id == ticket.chat_id)
            .order_by(Message.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    card = None
    if ticket.message_id and last_ticket != ticket.id:
        card = await db.get(Message, ticket.message_id)
    bot = await bot_user(db)
    message = await deliver(db, chat, bot.id, text, reply_to=card)
    db.add(SupportMessage(message_id=message.id, ticket_id=ticket.id, admin_id=admin_id))
    ticket.updated_at = _now()
    await db.commit()
    return message


def _accepted_text(ticket: SupportTicket) -> str:
    return (
        f"Спасибо! Обращение №{ticket.number} ({KINDS[ticket.kind].lower()}) принято. "
        "Ответим здесь же — а пока можно дописать подробности."
    )


async def create_ticket(
    db: AsyncSession, user: User, kind: str, text: str, images: list[TicketImage]
) -> SupportTicket:
    """Обращение из формы: карточка от имени человека и ответ бота."""
    from fastapi import HTTPException

    from app.api.messages import deliver
    from app.models.attachment import Attachment

    chat = await support_chat(db, user)
    attachments = []
    for ref in images:
        attachment = (
            await db.execute(
                select(Attachment).where(
                    Attachment.id == ref.id,
                    Attachment.chat_id == chat.id,
                    Attachment.uploader_id == user.id,
                    Attachment.message_id.is_(None),
                )
            )
        ).scalar_one_or_none()
        if not attachment:
            raise HTTPException(status_code=422, detail="Картинка не найдена — прикрепите её заново")
        attachments.append(attachment)

    ticket = SupportTicket(
        user_id=user.id,
        chat_id=chat.id,
        kind=kind,
        text=text,
        images=[ref.model_dump() for ref in images],
    )
    db.add(ticket)
    await db.flush()
    card = await deliver(db, chat, user.id, card_payload(ticket), card=True)
    ticket.message_id = card.id
    for attachment in attachments:
        attachment.message_id = card.id
    db.add(SupportMessage(message_id=card.id, ticket_id=ticket.id))
    await db.commit()
    await bot_says(db, ticket, _accepted_text(ticket))
    await notify_team(db, ticket)
    return ticket


async def on_user_message(db: AsyncSession, chat: Chat, message: Message, reply_to: Message | None) -> None:
    """Человек написал боту сам: дописка к обращению или новый вопрос."""
    ticket = None
    if reply_to:
        ticket = (
            await db.execute(
                select(SupportTicket)
                .join(SupportMessage, SupportMessage.ticket_id == SupportTicket.id)
                .where(SupportMessage.message_id == reply_to.id)
            )
        ).scalar_one_or_none()
    if not ticket:
        ticket = (
            await db.execute(
                select(SupportTicket)
                .where(SupportTicket.chat_id == chat.id, SupportTicket.status != "done")
                .order_by(SupportTicket.updated_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if ticket:
        db.add(SupportMessage(message_id=message.id, ticket_id=ticket.id))
        ticket.updated_at = _now()
        await db.commit()
        await notify_team(db, ticket)
        return

    image = image_ref(message.payload)
    ticket = SupportTicket(
        user_id=message.sender_id,
        chat_id=chat.id,
        message_id=message.id,
        kind="question",
        text="" if image else message.payload,
        images=[image] if image else [],
    )
    db.add(ticket)
    await db.flush()
    db.add(SupportMessage(message_id=message.id, ticket_id=ticket.id))
    await db.commit()
    await bot_says(db, ticket, _accepted_text(ticket))
    await notify_team(db, ticket)


async def set_status(db: AsyncSession, ticket: SupportTicket, status: str, admin: User) -> None:
    """Новый статус: карточка в чате обновляется, бот сообщает человеку."""
    from app.api.messages import _get_chat_member_ids

    if ticket.status == status:
        return
    ticket.status = status
    ticket.updated_at = _now()
    card = await db.get(Message, ticket.message_id) if ticket.message_id else None
    if card and card.payload.startswith(TICKET_PREFIX):
        card.payload = card_payload(ticket)
    await db.commit()
    if card and card.payload.startswith(TICKET_PREFIX):
        # Не правка текста — без пометки «изменено».
        await manager.broadcast_to_users(
            await _get_chat_member_ids(ticket.chat_id, db),
            {
                "type": "message_edited",
                "chat_id": ticket.chat_id,
                "message_id": card.id,
                "payload": card.payload,
                "edited_at": None,
            },
        )
    text = {
        "queued": f"Обращение №{ticket.number} снова в очереди.",
        "in_progress": f"Взяли обращение №{ticket.number} в работу.",
        "done": f"Обращение №{ticket.number} — готово. Спасибо, что помогаете сделать Квазар лучше!",
    }[status]
    await bot_says(db, ticket, text, admin_id=admin.id)
    await notify_team(db, ticket)


async def queued_count(db: AsyncSession) -> int:
    return (
        await db.execute(select(func.count()).select_from(SupportTicket).where(SupportTicket.status == "queued"))
    ).scalar_one()

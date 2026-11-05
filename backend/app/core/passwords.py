"""Единая проверка новых паролей и завершение сессий после их изменения."""

from datetime import datetime, timezone

from app.core.security import hash_password
from app.ws.hub import manager


def validate_password(value: str) -> str:
    if len(value) < 8 or not value.strip():
        raise ValueError("Пароль — не короче 8 символов и не из одних пробелов")
    if len(value.encode("utf-8")) > 72:
        raise ValueError("Пароль слишком длинный. Используйте более короткий пароль")
    return value


def assign_password(user, password: str) -> None:
    user.password_hash = hash_password(validate_password(password))
    user.password_changed_at = datetime.now(timezone.utc)


async def close_sessions(user_id: str) -> None:
    for ws in list(manager.user_connections.get(user_id, [])):
        try:
            await ws.close(code=4001)
        except Exception:
            pass


async def complete_recoveries(db, user, admin=None, *, phone_verified=False):
    """Пароль, статус заявок, карточки и запись о смене фиксируются одним коммитом вызывающего."""
    import uuid
    from fastapi import HTTPException
    from sqlalchemy import select
    from app.core import support
    from app.models.message import Message
    from app.models.support import SupportMessage, SupportTicket
    from app.models.user import User

    tickets = (await db.execute(select(SupportTicket).where(
        SupportTicket.user_id == user.id, SupportTicket.recovery_login.is_not(None),
        SupportTicket.status != "done", SupportTicket.password_reset_at.is_(None),
    ).with_for_update())).scalars().all()
    if not tickets:
        return []
    bot = (await db.execute(select(User).where(User.phone == support.BOT_PHONE, User.is_official.is_(True)))).scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=503, detail="Служба поддержки сейчас недоступна")
    text = ("Администратор назначил новый пароль для входа. Получите его у администратора вне Quazar."
            if admin else "Владелец аккаунта изменил пароль в настройках. Запрос восстановления завершён.")
    if phone_verified:
        text = "Телефон подтверждён. Вход доступен звонком или через привязанный Яндекс ID; парольное восстановление завершено."
    for ticket in tickets:
        ticket.status = "done"
        ticket.password_reset_at = None if phone_verified else user.password_changed_at
        ticket.password_reset_by_id = admin.id if admin else None
        ticket.updated_at = user.phone_verified_at if phone_verified else user.password_changed_at
        card = await db.get(Message, ticket.message_id) if ticket.message_id else None
        if card and card.payload.startswith(support.TICKET_PREFIX):
            card.payload = support.card_payload(ticket)
        message = Message(id=str(uuid.uuid4()), chat_id=ticket.chat_id, sender_id=bot.id, payload=text)
        db.add(message)
        await db.flush()
        db.add(SupportMessage(message_id=message.id, ticket_id=ticket.id, admin_id=admin.id if admin else None))
    return tickets

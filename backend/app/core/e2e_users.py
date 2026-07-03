"""E2E helpers for user keys and direct-chat notifications."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.chat import Chat, ChatMember


async def get_direct_chat_partner_ids(user_id: str, db: AsyncSession) -> list[str]:
    """Возвращает ID пользователей из direct-чатов с данным user_id."""
    my_chats = (
        select(ChatMember.chat_id).where(ChatMember.user_id == user_id).scalar_subquery()
    )
    result = await db.execute(
        select(ChatMember.user_id)
        .join(Chat, Chat.id == ChatMember.chat_id)
        .where(
            Chat.type == "direct",
            ChatMember.chat_id.in_(my_chats),
            ChatMember.user_id != user_id,
        )
        .distinct()
    )
    return [row[0] for row in result.all()]

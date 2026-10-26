"""Блокировки: кто кого заблокировал и что из этого следует для личного чата."""

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.chat import Chat, ChatMember
from app.models.moderation import UserBlock


async def blocked_ids(db: AsyncSession, user_id: str) -> set[str]:
    """Кого заблокировал user_id."""
    rows = await db.execute(select(UserBlock.blocked_id).where(UserBlock.blocker_id == user_id))
    return set(rows.scalars().all())


async def block_state(db: AsyncSession, me: str, other: str) -> tuple[bool, bool]:
    """(я заблокировал его, он заблокировал меня)."""
    rows = await db.execute(
        select(UserBlock.blocker_id).where(
            or_(
                (UserBlock.blocker_id == me) & (UserBlock.blocked_id == other),
                (UserBlock.blocker_id == other) & (UserBlock.blocked_id == me),
            )
        )
    )
    blockers = set(rows.scalars().all())
    return me in blockers, other in blockers


async def direct_peer(db: AsyncSession, chat_id: str, me: str) -> str | None:
    """Собеседник в личном чате; в группе и «Избранном» — None."""
    chat_type = (await db.execute(select(Chat.type).where(Chat.id == chat_id))).scalar_one_or_none()
    if chat_type != "direct":
        return None
    rows = await db.execute(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat_id, ChatMember.user_id != me)
    )
    return rows.scalars().first()

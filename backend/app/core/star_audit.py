"""Журнал действий в Звезде: модерация, роли, каналы, настройки. Читают владелец и админы."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.star import StarAudit

# Что пишем в журнал (для подписей на клиенте — web/src/components/constellation/audit.ts).
ACTIONS = (
    "kick",
    "ban",
    "unban",
    "role",
    "timeout",
    "message_delete",
    "channel_create",
    "channel_update",
    "channel_delete",
    "channel_share",
    "permissions",
    "settings",
    "tag",
    "transfer",
    "webhook",
    "bot",
    "workflow",
)


async def record(
    db: AsyncSession, star_id: str, actor_id: str | None, action: str, target_id: str | None = None, **details
) -> None:
    db.add(StarAudit(star_id=star_id, actor_id=actor_id, action=action, target_id=target_id, details=details))
    await db.commit()

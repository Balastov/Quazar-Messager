"""История правок сообщений: прежние версии хранятся отдельно, последние REVISIONS_KEPT на сообщение."""

from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

REVISIONS_KEPT = 20


async def remember(db: AsyncSession, model, message_id: str, written_at: datetime, **content) -> None:
    """Сохранить прежнюю версию перед правкой и убрать самые старые сверх лимита."""
    db.add(model(message_id=message_id, written_at=written_at, **content))
    await db.flush()
    keep = (
        select(model.id)
        .where(model.message_id == message_id)
        .order_by(model.written_at.desc())
        .limit(REVISIONS_KEPT)
    )
    await db.execute(delete(model).where(model.message_id == message_id, model.id.not_in(keep)))

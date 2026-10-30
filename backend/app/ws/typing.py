"""«Печатает…» в чатах и Спутниках.

Клиент, пока набирает текст, шлёт {"type": "typing", "chat_id"} или
{"type": "typing", "star_id", "channel_id"} — не чаще раза в 3 с. Остальные участники
получают typing / star_typing и показывают подпись ~5 с после последнего события.
Ничего не хранится: только рассылка тем, кто сейчас на связи.
"""

import time

from sqlalchemy import select

from app.core.blocks import block_state, direct_peer
from app.core.database import AsyncSessionLocal
from app.models.chat import ChatMember
from app.core import shares
from app.models.star import StarChannel, StarMember
from app.ws.hub import manager

# Чаще этого одному человеку в одно место не рассылаем, сколько бы клиент ни слал.
THROTTLE_SEC = 2.0
_MAX_TRACKED = 10_000

session_factory = AsyncSessionLocal
_last_sent: dict[tuple[str, str], float] = {}


def _allow(user_id: str, target: str) -> bool:
    now = time.monotonic()
    key = (user_id, target)
    if now - _last_sent.get(key, 0.0) < THROTTLE_SEC:
        return False
    if len(_last_sent) >= _MAX_TRACKED:
        for k, at in list(_last_sent.items()):
            if now - at >= THROTTLE_SEC:
                del _last_sent[k]
    _last_sent[key] = now
    return True


def reset() -> None:
    _last_sent.clear()


async def handle_typing(data: dict, user_id: str) -> None:
    chat_id = data.get("chat_id")
    star_id = data.get("star_id")
    channel_id = data.get("channel_id")
    if isinstance(chat_id, str) and chat_id:
        await _chat_typing(chat_id, user_id)
    elif isinstance(star_id, str) and star_id and isinstance(channel_id, str) and channel_id:
        await _star_typing(star_id, channel_id, user_id)


async def _chat_typing(chat_id: str, user_id: str) -> None:
    if not _allow(user_id, chat_id):
        return
    async with session_factory() as db:
        member_ids = (
            await db.execute(select(ChatMember.user_id).where(ChatMember.chat_id == chat_id))
        ).scalars().all()
        if user_id not in member_ids:
            return
        # Заблокированный (и заблокировавший) в личном чате не видят «печатает…».
        peer = await direct_peer(db, chat_id, user_id)
        if peer and any(await block_state(db, user_id, peer)):
            return
    await manager.broadcast_to_users(
        list(member_ids),
        {"type": "typing", "chat_id": chat_id, "user_id": user_id},
        exclude_user=user_id,
    )


async def _star_typing(star_id: str, channel_id: str, user_id: str) -> None:
    if not _allow(user_id, channel_id):
        return
    async with session_factory() as db:
        channel = (
            await db.execute(
                select(StarChannel).where(StarChannel.id == channel_id, StarChannel.kind == "satellite")
            )
        ).scalar_one_or_none()
        if not channel or (channel.star_id != star_id and not await shares.is_shared_into(db, channel_id, star_id)):
            return
        if not (
            await db.execute(
                select(StarMember.user_id).where(StarMember.star_id == star_id, StarMember.user_id == user_id)
            )
        ).first():
            return
        # Общий Спутник — участникам всех подключённых Звёзд, каждому со star_id его Звезды.
        audience: list[tuple[str, list[str]]] = []
        seen: set[str] = set()
        for sid in await shares.audience_star_ids(db, channel_id, star_id):
            ids = [
                uid
                for uid in (
                    await db.execute(select(StarMember.user_id).where(StarMember.star_id == sid))
                ).scalars()
                if uid not in seen
            ]
            seen.update(ids)
            audience.append((sid, ids))
    for sid, ids in audience:
        await manager.broadcast_to_users(
            ids,
            {"type": "star_typing", "star_id": sid, "channel_id": channel_id, "user_id": user_id},
            exclude_user=user_id,
        )

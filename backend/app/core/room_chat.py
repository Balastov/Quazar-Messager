"""Чат комнаты (Планеты): та же лента, что у Спутника, — с ответами, ветками, реакциями и файлами.

Читают и пишут те, кто может войти в комнату:
- открытая комната — все, кто её видит (в рабочей Звезде — с доступом к этажу или по гостевой ссылке);
- закрытая (по приглашениям, личный кабинет, сбор) — кто входит без стука (пустая комната
  «по приглашениям» не в счёт), кто впускает по стуку, кто сейчас внутри и у кого гостевая ссылка
  в эту комнату.
В зале ожидания чата нет. Гости без аккаунта чат не видят.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import floors as floors_svc
from app.core import voice
from app.models.star import Star, StarChannel, StarMember

# Чат комнаты по умолчанию не шумит: упоминания и ответы мне. Если Звезда настроена тише — как Звезда.
ROOM_DEFAULT = "mentions"

# События ленты: их получает только аудитория чата, а не все, кто видит комнату.
CHAT_EVENTS = frozenset({
    "star_message", "star_message_edited", "star_message_deleted", "star_message_reaction",
    "star_thread", "star_pins", "star_ack", "star_typing", "star_poll", "star_lfg",
})


def has_chat(channel: StarChannel) -> bool:
    return channel.kind == "planet" and channel.room_kind != floors_svc.LOBBY_KIND


def default_level(star_level: str) -> str:
    """Уровень чата комнаты без своей настройки: «Все сообщения» Звезды становятся упоминаниями и ответами."""
    return ROOM_DEFAULT if star_level == "all" else star_level


def _keyholder(star: Star, member: StarMember, channel: StarChannel) -> bool:
    """Входит без стука или сам впускает. Пустая комната «по приглашениям» открыта всем — это не в счёт."""
    from app.api import doors

    return doors.enters_freely(star, member, channel, occupied=True) or doors.can_answer(star, member, channel)


def _inside(channel_id: str) -> set[str]:
    return {p.user_id for p in voice.participants(channel_id) if not voice.is_guest(p.user_id)}


def _readable(
    star: Star, member: StarMember, channel: StarChannel, view: floors_svc.View, passes: dict[str, object]
) -> bool:
    from app.api import doors

    if not has_chat(channel) or not view.sees_room(channel):
        return False
    if star.kind != "work" and member.role == floors_svc.VISITOR:
        return False
    # Гостевая ссылка — приглашение: по ней входят без стука.
    if member.role == floors_svc.VISITOR or channel.id in passes or not doors.is_closed(channel):
        return True
    return member.user_id in _inside(channel.id) or _keyholder(star, member, channel)


async def can_read(db: AsyncSession, star: Star, member: StarMember, channel: StarChannel) -> bool:
    if not has_chat(channel):
        return False
    view = await floors_svc.view_of(db, star, member)
    passes = (await floors_svc.room_passes(db, star.id, [member.user_id])).get(member.user_id, {})
    return _readable(star, member, channel, view, passes)


async def hidden_rooms(db: AsyncSession, star: Star, member: StarMember) -> set[str]:
    """Комнаты Звезды, чат которых этому человеку не виден (для поиска и списка файлов)."""
    rooms = (
        await db.execute(select(StarChannel).where(StarChannel.star_id == star.id, StarChannel.kind == "planet"))
    ).scalars().all()
    if not rooms:
        return set()
    view = await floors_svc.view_of(db, star, member)
    passes = (await floors_svc.room_passes(db, star.id, [member.user_id])).get(member.user_id, {})
    return {c.id for c in rooms if not _readable(star, member, c, view, passes)}


async def audience(db: AsyncSession, star: Star, channel: StarChannel) -> set[str]:
    """Кому слать события ленты и push: участники и посетители, которые могут читать чат."""
    from app.api import doors

    members = {
        m.user_id: m
        for m in (await db.execute(select(StarMember).where(StarMember.star_id == star.id))).scalars()
    }
    base = await floors_svc.room_audience(db, channel.id)
    if base is None:
        base = set(members)
    if not doors.is_closed(channel):
        return base
    inside = _inside(channel.id)
    passes = {uid for uid, rooms in (await floors_svc.room_passes(db, star.id)).items() if channel.id in rooms}
    return {
        uid for uid in base
        if uid in inside or uid in passes or (uid in members and _keyholder(star, members[uid], channel))
    }

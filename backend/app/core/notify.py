"""Уровни уведомлений и @упоминания.

Уровень — all | mentions | none, для чата, Звезды и Спутника (Спутник → Звезда → по умолчанию).
muted_until — временная тишина. Непрочитанное считается всегда: уровень решает только, будет ли
всплывашка, звук и push. Тот же расчёт — web/src/notifications/levels.ts.
"""
from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import markup, work_hours
from app.core.push import send_push_to_user
from app.models.notify import NotifySetting
from app.models.star import Star, StarChannel, StarMember, StarMessage
from app.models.user import User
from app.ws.hub import manager

log = logging.getLogger(__name__)

LEVELS = ("all", "mentions", "none")
CHAT_DEFAULT = "all"
# В Звёздах по умолчанию — только упоминания и ответы мне: в больших Звёздах «всё» быстро надоедает.
STAR_DEFAULT = "mentions"
# @все / @channel — всем участникам, @here / @тут — тем, кто сейчас в сети (оба пишут модераторы и выше).
ALL_WORDS = {"все", "all", "everyone", "channel", "канал"}
HERE_WORDS = {"here", "тут", "здесь"}
# Эти слова нельзя занять под имя группы.
RESERVED_WORDS = ALL_WORDS | HERE_WORDS

_MENTION = re.compile(r"(?<![\w@.])@([\w.]{2,64})")


@dataclass
class Mentions:
    # Упомянутые по имени и через группы.
    ids: set[str] = field(default_factory=set)
    everyone: bool = False
    here: bool = False


def find_mentions(text: str, usernames: dict[str, str], groups: dict[str, list[str]] | None = None) -> Mentions:
    """@имя → id участников, @группа → id всех в группе (без учёта регистра), @все и @here.

    usernames: имя в нижнем регистре → id; groups: имя группы в нижнем регистре → id участников.
    """
    found = Mentions()
    groups = groups or {}
    # «@имя» в коде — пример, а не упоминание.
    for raw in _MENTION.findall(markup.without_code(text)):
        for name in (raw, raw.rstrip(".")):
            key = name.lower()
            if key in ALL_WORDS:
                found.everyone = True
                break
            if key in HERE_WORDS:
                found.here = True
                break
            if key in usernames:
                found.ids.add(usernames[key])
                break
            if key in groups:
                found.ids.update(groups[key])
                break
    return found


def parse_mentions(text: str, usernames: dict[str, str]) -> tuple[set[str], bool]:
    """@имя → id участников и было ли @все (или @here) — без групп."""
    found = find_mentions(text, usernames)
    return found.ids, found.everyone or found.here


def _active(setting: NotifySetting | None, now: datetime) -> bool:
    return bool(setting and setting.muted_until and setting.muted_until > now)


def star_level(
    star_setting: NotifySetting | None, channel_setting: NotifySetting | None, now: datetime
) -> str:
    """Итоговый уровень в Спутнике с учётом временной тишины ("none", пока она идёт)."""
    if _active(star_setting, now) or _active(channel_setting, now):
        return "none"
    for s in (channel_setting, star_setting):
        if s and s.level:
            return s.level
    return STAR_DEFAULT


async def star_push_targets(
    db: AsyncSession, star: Star, channel: StarChannel, message: StarMessage, also_mentioned: Iterable[str] = ()
) -> list[str]:
    """Кому слать push о сообщении Спутника: уровень позволяет, нет открытого приложения,
    не «не беспокоить» и не нерабочее время."""
    now = datetime.now(timezone.utc)
    member_ids = [
        uid
        for uid in (await db.execute(select(StarMember.user_id).where(StarMember.star_id == star.id))).scalars()
        if uid != message.sender_id
    ]
    if not member_ids:
        return []
    rows = (
        await db.execute(
            select(NotifySetting).where(
                NotifySetting.user_id.in_(member_ids),
                ((NotifySetting.scope == "star") & (NotifySetting.target_id == star.id))
                | ((NotifySetting.scope == "channel") & (NotifySetting.target_id == channel.id)),
            )
        )
    ).scalars().all()
    by_user: dict[str, dict[str, NotifySetting]] = {}
    for s in rows:
        by_user.setdefault(s.user_id, {})[s.scope] = s
    mentioned = set(message.mentions or []) | set(also_mentioned)
    wanted = []
    for uid in member_ids:
        level = star_level(by_user.get(uid, {}).get("star"), by_user.get(uid, {}).get("channel"), now)
        # Ответ в ветке тревожит только упомянутых и автора ветки — даже при «Все сообщения».
        if message.thread_id and level == "all":
            level = "mentions"
        if level == "all" or (level == "mentions" and (message.mention_all or uid in mentioned)):
            wanted.append(uid)
    # Приложение открыто — там покажет всплывашку сам клиент.
    wanted = [uid for uid in wanted if not manager.user_connections.get(uid)]
    if not wanted:
        return []
    statuses = (
        await db.execute(select(User.id, User.manual_status, User.manual_status_until).where(User.id.in_(wanted)))
    ).all()
    dnd = {uid for uid, kind, until in statuses if kind == "dnd" and (until is None or until > now)}
    resting = await work_hours.resting(db, star, wanted, now)
    return [uid for uid in wanted if uid not in dnd and uid not in resting]


async def _push_all(user_ids: list[str], payload: dict) -> None:
    for uid in user_ids:
        try:
            await send_push_to_user(uid, payload)
        except Exception:  # noqa: BLE001 — один сбой не должен остановить остальных
            log.warning("star push to %s failed", uid)


def push_later(user_ids: list[str], payload: dict) -> None:
    """Отправить push в фоне — ответ на отправку сообщения не ждёт сервисов push."""
    if user_ids:
        asyncio.get_running_loop().create_task(_push_all(user_ids, payload))

"""Двери комнат: «Позвать», «Постучаться» и ответы на стук, зал ожидания, главный в комнате.

Виды дверей Планеты:
- open — свободный вход;
- invite («По приглашениям — стучаться») — в пустую комнату входит кто угодно и становится
  главным; пока внутри кто-то есть, войти можно по приглашению или постучавшись. Впускает и зовёт
  главный, а также те, у кого есть право «Впускать» (они же входят без стука);
- personal («Личный кабинет», Звёзды «Работа») — без стука входит только хозяин кабинета;
  впускает и зовёт хозяин, админы и владелец Звезды.

Кто в сети — получает событие по WebSocket, кто нет — push-уведомление.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.stars import _broadcast, _channel, _channel_event, _load_membership, _target_member, floors_event
from app.core import doors, voice
from app.core import floors as floors_svc
from app.core import stars as rules
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.push import send_push_to_user
from app.core import presence, work_hours
from app.core.stars import Perm
from app.models.star import Star, StarChannel, StarMember
from app.models.user import User
from app.ws.hub import manager

router = APIRouter(prefix="/stars", tags=["doors"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

LOBBY_KIND = "lobby"
LOBBY_NAME = "Зал ожидания"


class InviteBody(BaseModel):
    user_id: str


class HostBody(BaseModel):
    user_id: str


class AnswerBody(BaseModel):
    action: Literal["admit", "wait", "deny"]


class KnockOut(BaseModel):
    id: str
    star_id: str
    channel_id: str
    user_id: str
    status: str
    lobby_channel_id: str | None


# --- Вспомогательное ------------------------------------------------------


def can_admit(star: Star, member: StarMember) -> bool:
    return rules.has_perm(member.role, Perm.ADMIT, star.role_permissions)


OPEN, INVITE, PERSONAL = "open", "invite", "personal"


def door(channel: StarChannel) -> str:
    if channel.kind != "planet" or channel.room_kind == LOBBY_KIND:
        return OPEN
    return channel.access if channel.access in (INVITE, PERSONAL) else OPEN


def is_closed(channel: StarChannel) -> bool:
    return door(channel) != OPEN


def enters_freely(star: Star, member: StarMember, channel: StarChannel, occupied: bool | None = None) -> bool:
    """Можно войти без стука и приглашения. occupied — есть ли кто внутри (по умолчанию — реестр)."""
    kind = door(channel)
    if kind == OPEN:
        return True
    if kind == PERSONAL:
        return member.user_id == channel.cabinet_owner_id
    if occupied is None:
        occupied = bool(voice.participants(channel.id))
    return not occupied or can_admit(star, member)


def can_answer(star: Star, member: StarMember, channel: StarChannel) -> bool:
    """Впускать по стуку и звать в комнату."""
    kind = door(channel)
    if kind == PERSONAL:
        return member.user_id == channel.cabinet_owner_id or member.role in ("owner", "admin")
    if kind == INVITE:
        return voice.host(channel.id) == member.user_id or can_admit(star, member)
    return False


def enter_words(star: Star, room_name: str) -> dict[str, str]:
    """Как называть вход (как в вебе, words.ts): «Войти в Комнату» в Звёздах «Работа»,
    «Посетить Планету» в игровых. room_name — для совместимости вызовов, в кнопку не идёт."""
    if star.kind == "work":
        return {
            "enter": "Войти в Комнату",
            "free": "можно войти",
            "open": "Комната открыта — входите без стука",
            "empty": "В Комнате никого нет — входите",
            "inside": "Вы уже в Комнате",
        }
    return {
        "enter": "Посетить Планету",
        "free": "можно посетить",
        "open": "Планета открыта — посещайте без стука",
        "empty": "На Планете никого нет — можно посетить",
        "inside": "Вы уже на Планете",
    }


def _who_answers(channel: StarChannel) -> str:
    if door(channel) == PERSONAL:
        return "Звать и впускать в личный кабинет могут его хозяин, админы и владелец Звезды"
    return "Звать и впускать сюда может главный (и те, у кого есть право впускать)"


async def _names(db: AsyncSession, user_ids: set[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    rows = (await db.execute(select(User.id, User.username).where(User.id.in_(user_ids)))).all()
    return dict(rows)


async def _answerers(db: AsyncSession, star: Star, channel: StarChannel) -> list[str]:
    """Кто может впускать в эту комнату."""
    members = (await db.execute(select(StarMember).where(StarMember.star_id == star.id))).scalars().all()
    return [m.user_id for m in members if can_answer(star, m, channel)]


async def _notify(
    user_ids: list[str], event: dict, push: dict | None = None, *, resting: set[str] = frozenset()
) -> None:
    """WebSocket — всем; push — тем, у кого сейчас нет открытого приложения и не нерабочее время (resting)."""
    targets = list(dict.fromkeys(user_ids))
    await manager.broadcast_to_users(targets, event)
    if push:
        for uid in targets:
            if uid in resting:
                continue
            # «Не беспокоить» — без push (в открытом приложении стук всё равно виден).
            if not manager.user_connections.get(uid) and not await presence.do_not_disturb(uid):
                await send_push_to_user(uid, {"type": "star_door", **push})


async def _knock_event(db: AsyncSession, knock: doors.Knock, star: Star, channel: StarChannel) -> dict:
    names = await _names(db, {knock.user_id})
    return {
        "type": "planet_knock",
        "star_id": star.id,
        "knock": knock.out(),
        "user_name": names.get(knock.user_id, "Участник"),
        "room_name": channel.name,
        "star_name": star.name,
        "expires_in": doors.KNOCK_TTL_SEC if knock.status == "pending" else doors.WAITING_TTL_SEC,
    }


async def _knock_audience(db: AsyncSession, star: Star, channel: StarChannel) -> list[str]:
    """Стук видят те, кто может впустить в эту комнату."""
    return await _answerers(db, star, channel)


async def _close_knock(db: AsyncSession, star: Star, knock: doors.Knock) -> None:
    # Закрытие шлём всем участникам: кто мог впускать, мог смениться (ушёл главный).
    members = (
        await db.execute(select(StarMember.user_id).where(StarMember.star_id == star.id))
    ).scalars().all()
    await _notify(list(members), {"type": "planet_knock_closed", "star_id": star.id, "knock_id": knock.id})


async def ensure_lobby(db: AsyncSession, star: Star) -> StarChannel:
    """Зал ожидания Звезды: создаётся при первой надобности, вход свободный."""
    existing = (
        await db.execute(
            select(StarChannel).where(StarChannel.star_id == star.id, StarChannel.room_kind == LOBBY_KIND)
        )
    ).scalar_one_or_none()
    if existing:
        return existing

    await db.execute(select(Star.id).where(Star.id == star.id).with_for_update())
    max_position = (
        await db.execute(
            select(func.max(StarChannel.position)).where(
                StarChannel.star_id == star.id, StarChannel.kind == "planet"
            )
        )
    ).scalar_one()
    lobby = StarChannel(
        star_id=star.id,
        kind="planet",
        name=LOBBY_NAME,
        position=0 if max_position is None else max_position + 1,
        room_kind=LOBBY_KIND,
        capacity=rules.PLANET_MAX_CAPACITY,
        access="open",
    )
    db.add(lobby)
    floor = None
    if star.kind == "work":
        floors = await floors_svc.ensure_floors(db, star)
        floor = await floors_svc.lock_floor(db, star.id, floors[0].id)
        await floors_svc.place_room(db, lobby, floor)
    await db.commit()
    await _broadcast(db, star.id, _channel_event(lobby))
    if floor:
        await _broadcast(db, star.id, floors_event(await floors_svc.list_floors(db, star.id)))
    return lobby


# --- Позвать --------------------------------------------------------------


@router.post("/{star_id}/planets/{channel_id}/invite", status_code=status.HTTP_204_NO_CONTENT)
async def invite_to_planet(star_id: str, channel_id: str, body: InviteBody, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    if channel.kind != "planet":
        raise HTTPException(status_code=400, detail="Позвать можно только в Планету")
    inside = {p.user_id for p in voice.participants(channel_id)}
    if current_user.id not in inside:
        raise HTTPException(status_code=409, detail="Позвать можно только в комнату, где вы сейчас находитесь")
    if is_closed(channel) and not can_answer(star, me, channel):
        raise HTTPException(status_code=403, detail=_who_answers(channel))
    await _target_member(db, star_id, body.user_id)
    if body.user_id in inside:
        raise HTTPException(status_code=409, detail="Этот участник уже в комнате")

    doors.grant_pass(body.user_id, channel_id, ttl=doors.INVITE_TTL_SEC)
    await _notify(
        [body.user_id],
        {
            "type": "planet_invite",
            "star_id": star_id,
            "channel_id": channel_id,
            "from_user_id": current_user.id,
            "from_name": current_user.username,
            "room_name": channel.name,
            "star_name": star.name,
            "expires_in": doors.INVITE_TTL_SEC,
        },
        push={
            "door": "invite",
            "title": f"{current_user.username} зовёт вас",
            "body": f"в «{channel.name}» · {star.name}",
            # Кнопка уведомления: «Войти в …» / «Отправиться на планету …».
            "action_title": enter_words(star, channel.name)["enter"],
            "star_id": star_id,
            "channel_id": channel_id,
        },
        resting=await work_hours.resting(db, star, [body.user_id]),
    )


# --- Постучаться ----------------------------------------------------------


@router.post("/{star_id}/planets/{channel_id}/knock", response_model=KnockOut)
async def knock_on_planet(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    words = enter_words(star, channel.name)
    if channel.kind != "planet" or not is_closed(channel):
        raise HTTPException(status_code=400, detail=words["open"])
    if door(channel) == INVITE and not voice.participants(channel_id):
        raise HTTPException(status_code=409, detail=words["empty"])
    if enters_freely(star, me, channel):
        raise HTTPException(status_code=400, detail="Вам можно без стука")
    if current_user.id in {p.user_id for p in voice.participants(channel_id)}:
        raise HTTPException(status_code=400, detail=words["inside"])

    knock, created = doors.knock(star_id, channel_id, current_user.id)
    if created:
        audience = await _knock_audience(db, star, channel)
        await _notify(
            audience,
            await _knock_event(db, knock, star, channel),
            push={
                "door": "knock",
                "title": f"{current_user.username} стучится",
                "body": f"в «{channel.name}» · {star.name}",
                "star_id": star_id,
                "channel_id": channel_id,
                "knock_id": knock.id,
            },
            resting=await work_hours.resting(db, star, audience),
        )
    return KnockOut(**knock.out())


@router.get("/{star_id}/knocks")
async def list_knocks(star_id: str, current_user: CurrentUser, db: Db):
    """Стуки Звезды: тем, кто может впускать, — все; остальным — свои."""
    star, me = await _load_membership(db, star_id, current_user.id)
    channels = {
        c.id: c
        for c in (
            await db.execute(select(StarChannel).where(StarChannel.star_id == star_id))
        ).scalars()
    }
    result = []
    for knock in doors.star_knocks(star_id):
        channel = channels.get(knock.channel_id)
        if channel and (knock.user_id == current_user.id or can_answer(star, me, channel)):
            result.append(await _knock_event(db, knock, star, channel))
    return result


@router.delete("/{star_id}/knocks/{knock_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_knock(star_id: str, knock_id: str, current_user: CurrentUser, db: Db):
    star, _ = await _load_membership(db, star_id, current_user.id)
    knock = doors.get(knock_id)
    if not knock or knock.star_id != star_id or knock.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Стук не найден")
    doors.remove(knock_id)
    await _close_knock(db, star, knock)


@router.post("/{star_id}/knocks/{knock_id}/answer", status_code=status.HTTP_204_NO_CONTENT)
async def answer_knock(star_id: str, knock_id: str, body: AnswerBody, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    knock = doors.get(knock_id)
    if not knock or knock.star_id != star_id:
        raise HTTPException(status_code=404, detail="На этот стук уже ответили или он устарел")
    channel = await _channel(db, star_id, knock.channel_id)
    if knock.user_id == current_user.id or not can_answer(star, me, channel):
        raise HTTPException(status_code=403, detail=_who_answers(channel))

    answer = {
        "type": "planet_knock_answer",
        "star_id": star_id,
        "channel_id": channel.id,
        "knock_id": knock.id,
        "action": body.action,
        "room_name": channel.name,
        "star_name": star.name,
        "by_name": current_user.username,
    }
    push = {"star_id": star_id, "channel_id": channel.id, "knock_id": knock.id, "door": body.action}

    if body.action == "admit":
        doors.remove(knock_id)
        doors.grant_pass(knock.user_id, channel.id)
        await _notify(
            [knock.user_id], answer,
            push={**push, "title": "Вас впустили", "body": f"в «{channel.name}» · {star.name}"},
        )
        await _close_knock(db, star, knock)
    elif body.action == "wait":
        lobby = await ensure_lobby(db, star)
        doors.send_to_waiting(knock_id, lobby.id)
        await _notify(
            [knock.user_id], {**answer, "lobby_channel_id": lobby.id},
            push={**push, "lobby_channel_id": lobby.id, "title": "Подождите в зале ожидания",
                  "body": f"вас впустят в «{channel.name}» · {star.name}"},
        )
        await _notify(await _knock_audience(db, star, channel), await _knock_event(db, knock, star, channel))
    else:
        doors.remove(knock_id)
        await _notify(
            [knock.user_id], answer,
            push={**push, "title": "Вам отказали", "body": f"в «{channel.name}» · {star.name}"},
        )
        await _close_knock(db, star, knock)


# --- Хуки -----------------------------------------------------------------


async def on_participant_left(db: AsyncSession, star_id: str, channel_id: str, user_id: str | None) -> None:
    """Кто-то ушёл с Планеты (или комната закрылась целиком)."""
    star = (await db.execute(select(Star).where(Star.id == star_id))).scalar_one_or_none()
    if not star:
        return
    # Ушёл из зала ожидания — ожидание снимается.
    if user_id:
        for knock in doors.left_lobby(star_id, channel_id, user_id):
            await _close_knock(db, star, knock)
    await on_room_changed(db, star, channel_id)


async def on_room_changed(db: AsyncSession, star: Star, channel_id: str) -> None:
    """Сменился главный или комната опустела — стуки к новому главному или «заходите»."""
    channel = (
        await db.execute(select(StarChannel).where(StarChannel.id == channel_id))
    ).scalar_one_or_none()
    if not channel or door(channel) != INVITE:
        return
    knocks = [k for k in doors.star_knocks(star.id) if k.channel_id == channel_id]
    if not knocks:
        return
    if voice.participants(channel_id):
        host_id = voice.host(channel_id)
        if host_id:
            for knock in knocks:
                await _notify([host_id], await _knock_event(db, knock, star, channel))
        return
    # Пустая комната «По приглашениям» открыта всем — ждать больше некого.
    for knock in knocks:
        doors.remove(knock.id)
        await _notify(
            [knock.user_id],
            {
                "type": "planet_knock_answer",
                "star_id": star.id,
                "channel_id": channel.id,
                "knock_id": knock.id,
                "action": "free",
                "room_name": channel.name,
                "star_name": star.name,
                "by_name": "",
            },
            push={
                "star_id": star.id, "channel_id": channel.id, "knock_id": knock.id, "door": "free",
                "title": "Комната освободилась" if star.kind == "work" else "Планета освободилась",
                "body": f"«{channel.name}» · {star.name} — {enter_words(star, channel.name)['free']}",
                "action_title": enter_words(star, channel.name)["enter"],
            },
        )
        await _close_knock(db, star, knock)


# --- Главный в комнате ----------------------------------------------------


@router.post("/{star_id}/planets/{channel_id}/host", status_code=status.HTTP_204_NO_CONTENT)
async def make_host(star_id: str, channel_id: str, body: HostBody, current_user: CurrentUser, db: Db):
    """«Сделать главным»: главный передаёт звание другому, кто сейчас в комнате."""
    star, _ = await _load_membership(db, star_id, current_user.id)
    channel = await _channel(db, star_id, channel_id)
    if door(channel) != INVITE:
        raise HTTPException(status_code=400, detail="Главный бывает только в комнатах «По приглашениям»")
    if voice.host(channel_id) != current_user.id:
        raise HTTPException(status_code=403, detail="Передать звание может только главный в комнате")
    if body.user_id == current_user.id:
        return
    if not await voice.set_host(star_id, channel_id, body.user_id):
        raise HTTPException(status_code=409, detail="Этого участника нет в комнате")
    await on_room_changed(db, star, channel_id)

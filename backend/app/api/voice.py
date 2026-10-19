"""Голос на Планетах: вход, показ экрана, модерация, вебхуки LiveKit."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from app.api.doors import enters_freely, is_closed
from app.api.stars import _channel, _load_membership, _target_member
from app.core import doors, livekit, voice
from app.core import stars as rules
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.stars import Perm
from app.models.user import User
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/stars", tags=["voice"])
webhook_router = APIRouter(tags=["voice"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]


class PlanetJoinOut(BaseModel):
    url: str
    token: str
    room: str


class VoiceMute(BaseModel):
    muted: bool


def _unavailable(detail: str = "Голосовая связь на Планетах пока не настроена на сервере") -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)


async def _planet(db: AsyncSession, star_id: str, channel_id: str):
    channel = await _channel(db, star_id, channel_id)
    if channel.kind != "planet":
        raise HTTPException(status_code=400, detail="Голос есть только на Планетах")
    return channel


@router.post("/{star_id}/planets/{channel_id}/join", response_model=PlanetJoinOut)
async def join_planet(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    star, me = await _load_membership(db, star_id, current_user.id)
    channel = await _planet(db, star_id, channel_id)
    if not livekit.configured():
        raise _unavailable()

    room = voice.room_name(channel_id)
    capacity = channel.capacity or rules.DEFAULT_PLANET_CAPACITY
    try:
        # Жёсткий потолок держит сам LiveKit; вместимость Планеты проверяем здесь.
        await livekit.room_service.create_room(room, max_participants=rules.PLANET_MAX_CAPACITY)
        present = await livekit.room_service.list_participants(room)
    except livekit.LiveKitError as exc:
        raise _unavailable("Голосовой сервер сейчас недоступен. Попробуйте чуть позже.") from exc

    identities = {p.get("identity") for p in present}
    already_inside = current_user.id in identities
    if not already_inside and len(identities) >= capacity:
        raise HTTPException(
            status_code=409,
            detail=f"{'Комната' if star.kind == 'work' else 'Планета'} заполнена: {len(identities)} из {capacity}",
        )

    # Закрытая дверь: кто не входит свободно, тому нужен пропуск (позвали или впустили).
    occupied = bool(identities - {current_user.id})
    if is_closed(channel) and not already_inside and not enters_freely(star, me, channel, occupied):
        # Пропуск гасится, когда LiveKit подтвердит вход (вебхук): сорвалось подключение —
        # можно повторить, пока пропуск не истёк.
        if not doors.has_pass(current_user.id, channel_id):
            # 423 — клиент предложит постучаться.
            raise HTTPException(
                status_code=423,
                detail="Это личный кабинет — постучитесь, чтобы вас впустили"
                if channel.access == "personal"
                else "Комната по приглашениям — постучитесь, чтобы вас впустили",
            )

    token = livekit.participant_token(
        room=room,
        identity=current_user.id,
        name=current_user.username,
        metadata={"star_id": star_id, "channel_id": channel_id},
        sources=() if channel.listen_only else (livekit.SOURCE_MICROPHONE,),
    )
    return PlanetJoinOut(url=settings.LIVEKIT_PUBLIC_URL, token=token, room=room)


async def _moderation_target(db: AsyncSession, star_id: str, channel_id: str, user: User, target_id: str):
    star, me = await _load_membership(db, star_id, user.id)
    await _planet(db, star_id, channel_id)
    target = await _target_member(db, star_id, target_id)
    if not (
        rules.has_perm(me.role, Perm.VOICE_MODERATE, star.role_permissions)
        and rules.outranks(me.role, target.role)
    ):
        raise HTTPException(status_code=403, detail="Недостаточно прав")
    if not any(p.user_id == target_id for p in voice.participants(channel_id)):
        raise HTTPException(status_code=404, detail="Участника нет на Планете")
    if not livekit.configured():
        raise _unavailable()


@router.post(
    "/{star_id}/planets/{channel_id}/voice/{user_id}/mute", status_code=status.HTTP_204_NO_CONTENT
)
async def mute_participant(
    star_id: str, channel_id: str, user_id: str, body: VoiceMute, current_user: CurrentUser, db: Db
):
    await _moderation_target(db, star_id, channel_id, current_user, user_id)
    try:
        await voice.set_server_muted(star_id, channel_id, user_id, body.muted)
    except livekit.LiveKitError as exc:
        raise _unavailable("Голосовой сервер сейчас недоступен.") from exc


@router.post(
    "/{star_id}/planets/{channel_id}/voice/{user_id}/remove", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_participant(
    star_id: str, channel_id: str, user_id: str, current_user: CurrentUser, db: Db
):
    await _moderation_target(db, star_id, channel_id, current_user, user_id)
    await voice.remove_from_planet(star_id, channel_id, user_id)


@router.post("/{star_id}/planets/{channel_id}/screen", status_code=status.HTTP_204_NO_CONTENT)
async def start_screen(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    """Занять слот показа экрана: на Планете показывает не больше одного человека."""
    star, _ = await _load_membership(db, star_id, current_user.id)
    await _planet(db, star_id, channel_id)
    if not livekit.configured():
        raise _unavailable()
    try:
        started = await voice.start_screen(star_id, channel_id, current_user.id)
    except voice.ScreenBusy as busy:
        name = (
            await db.execute(select(User.username).where(User.id == busy.user_id))
        ).scalar_one_or_none()
        raise HTTPException(
            status_code=409, detail=f"Сейчас экран показывает {name or 'другой участник'}"
        ) from None
    except livekit.LiveKitError as exc:
        raise _unavailable("Голосовой сервер сейчас недоступен.") from exc
    if not started:
        raise HTTPException(
            status_code=409,
            detail="Сначала войдите в комнату" if star.kind == "work" else "Сначала отправьтесь на планету",
        )


@router.delete("/{star_id}/planets/{channel_id}/screen", status_code=status.HTTP_204_NO_CONTENT)
async def stop_my_screen(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await _load_membership(db, star_id, current_user.id)
    await voice.stop_screen(star_id, channel_id, current_user.id)


@router.post(
    "/{star_id}/planets/{channel_id}/voice/{user_id}/screen/stop",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def stop_screen_of(
    star_id: str, channel_id: str, user_id: str, current_user: CurrentUser, db: Db
):
    """Модератор, админ или владелец останавливает чужой показ экрана."""
    _, me = await _load_membership(db, star_id, current_user.id)
    await _planet(db, star_id, channel_id)
    target = await _target_member(db, star_id, user_id)
    if not rules.can_stop_screen(me.role, target.role):
        raise HTTPException(status_code=403, detail="Недостаточно прав")
    await voice.stop_screen(star_id, channel_id, user_id)


@webhook_router.post("/livekit/webhook", include_in_schema=False)
async def livekit_webhook(request: Request):
    if not livekit.configured():
        raise HTTPException(status_code=404)
    body = await request.body()
    try:
        event = livekit.verify_webhook(body, request.headers.get("Authorization"))
    except livekit.WebhookError as exc:
        raise HTTPException(status_code=401, detail="Invalid webhook signature") from exc
    await voice.handle_webhook(event)
    return {"ok": True}

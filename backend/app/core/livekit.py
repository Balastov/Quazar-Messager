"""Клиент LiveKit (медиасервер голосовых Планет) без SDK.

- Токены доступа — JWT HS256 в формате LiveKit (claim `video` с правами).
- Server API — Twirp JSON: POST {LIVEKIT_URL}/twirp/livekit.RoomService/<Method>.
- Вебхуки подписаны JWT с claim `sha256` = base64(sha256(тело запроса)).
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any

import httpx
from jose import JWTError, jwt

from app.core.config import settings

ROOM_SERVICE = "/twirp/livekit.RoomService/"
# Токен нужен только чтобы войти: LiveKit сам продлевает его во время разговора.
# Короткий срок не даёт «придержать» место и зайти, когда Планета уже заполнена.
CLIENT_TOKEN_TTL_SEC = 120
ADMIN_TOKEN_TTL_SEC = 60

# Источники треков (enum TrackSource LiveKit). В токене — строчными, в Server API — именами enum.
SOURCE_MICROPHONE = "MICROPHONE"
SOURCE_SCREEN_SHARE = "SCREEN_SHARE"
SOURCE_SCREEN_SHARE_AUDIO = "SCREEN_SHARE_AUDIO"
# protojson может прислать enum и числом.
_SOURCE_NUMBERS = {2: SOURCE_MICROPHONE, 3: SOURCE_SCREEN_SHARE, 4: SOURCE_SCREEN_SHARE_AUDIO}


def track_source(value: Any) -> str | None:
    """Источник трека из вебхука или ListParticipants: "SCREEN_SHARE" / 3 → "SCREEN_SHARE"."""
    if isinstance(value, int):
        return _SOURCE_NUMBERS.get(value)
    return str(value).upper() if value else None


class LiveKitError(Exception):
    pass


class WebhookError(Exception):
    pass


def configured() -> bool:
    return all(
        v.strip()
        for v in (
            settings.LIVEKIT_URL,
            settings.LIVEKIT_PUBLIC_URL,
            settings.LIVEKIT_API_KEY,
            settings.LIVEKIT_API_SECRET,
        )
    )


def _sign(claims: dict[str, Any], ttl: int) -> str:
    now = int(time.time())
    payload = {
        "iss": settings.LIVEKIT_API_KEY,
        "nbf": now - 5,
        "exp": now + ttl,
        **claims,
    }
    return jwt.encode(payload, settings.LIVEKIT_API_SECRET, algorithm="HS256")


def participant_token(
    *,
    room: str,
    identity: str,
    name: str,
    metadata: dict[str, Any],
    sources: tuple[str, ...] = (SOURCE_MICROPHONE,),
) -> str:
    """Токен для браузера: зайти в одну комнату, говорить и слушать.

    Публиковать можно только микрофон (на Планете «Только слушать» — ничего): показ экрана
    бэкенд разрешает отдельно (не больше одного на Планету) через update_publish_sources.
    """
    return _sign(
        {
            "sub": identity,
            "name": name,
            "metadata": json.dumps(metadata, ensure_ascii=False),
            "video": {
                "room": room,
                "roomJoin": True,
                # Пустой список источников у LiveKit значит «можно всё» — поэтому «ничего»
                # выражаем через canPublish=False.
                "canPublish": bool(sources),
                "canPublishSources": [s.lower() for s in sources],
                "canSubscribe": True,
                "canPublishData": False,
            },
        },
        CLIENT_TOKEN_TTL_SEC,
    )


def _admin_token(room: str | None) -> str:
    video: dict[str, Any] = {"roomCreate": True, "roomList": True, "roomAdmin": True}
    if room:
        video["room"] = room
    return _sign({"video": video}, ADMIN_TOKEN_TTL_SEC)


def field(obj: dict[str, Any], snake: str, default: Any = None) -> Any:
    """Twirp/protojson может отдавать поля и в snake_case, и в camelCase."""
    if snake in obj:
        return obj[snake]
    head, *rest = snake.split("_")
    camel = head + "".join(part.title() for part in rest)
    return obj.get(camel, default)


class RoomService:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self._transport = transport

    async def _call(self, method: str, body: dict[str, Any], *, room: str | None = None) -> dict:
        url = settings.LIVEKIT_URL.rstrip("/") + ROOM_SERVICE + method
        headers = {"Authorization": f"Bearer {_admin_token(room)}"}
        async with httpx.AsyncClient(transport=self._transport, timeout=10) as client:
            try:
                resp = await client.post(url, json=body, headers=headers)
            except httpx.HTTPError as exc:
                raise LiveKitError(f"LiveKit недоступен: {exc}") from exc
        if resp.status_code == 404:
            return {"_not_found": True}
        if resp.status_code >= 400:
            raise LiveKitError(f"LiveKit {method}: {resp.status_code} {resp.text[:200]}")
        return resp.json() if resp.content else {}

    async def create_room(self, name: str, *, max_participants: int, empty_timeout: int = 120) -> None:
        await self._call(
            "CreateRoom",
            {
                "name": name,
                "max_participants": max_participants,
                "empty_timeout": empty_timeout,
                "departure_timeout": 20,
            },
        )

    async def list_rooms(self) -> list[dict]:
        return (await self._call("ListRooms", {})).get("rooms", [])

    async def list_participants(self, room: str) -> list[dict]:
        return (await self._call("ListParticipants", {"room": room}, room=room)).get(
            "participants", []
        )

    async def remove_participant(self, room: str, identity: str) -> None:
        await self._call("RemoveParticipant", {"room": room, "identity": identity}, room=room)

    async def update_publish_sources(self, room: str, identity: str, sources: list[str]) -> None:
        """Что участнику можно публиковать. Отозванные источники LiveKit снимает с публикации."""
        await self._call(
            "UpdateParticipant",
            {
                "room": room,
                "identity": identity,
                "permission": {
                    # Пустой список источников у LiveKit значит «можно всё» — поэтому
                    # «ничего нельзя» выражаем через can_publish=False.
                    "can_publish": bool(sources),
                    "can_publish_sources": sources,
                    "can_subscribe": True,
                    "can_publish_data": False,
                },
            },
            room=room,
        )

    async def delete_room(self, room: str) -> None:
        await self._call("DeleteRoom", {"room": room}, room=room)


room_service = RoomService()


def verify_webhook(body: bytes, auth_header: str | None) -> dict[str, Any]:
    """Проверяет подпись вебхука LiveKit и возвращает событие."""
    if not auth_header:
        raise WebhookError("no authorization")
    token = auth_header.removeprefix("Bearer ").strip()
    try:
        claims = jwt.decode(
            token,
            settings.LIVEKIT_API_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
    except JWTError as exc:
        raise WebhookError(f"bad token: {exc}") from exc
    if claims.get("iss") != settings.LIVEKIT_API_KEY:
        raise WebhookError("wrong issuer")
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    if claims.get("sha256") != digest:
        raise WebhookError("body hash mismatch")
    try:
        return json.loads(body)
    except ValueError as exc:
        raise WebhookError("bad json") from exc

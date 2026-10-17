"""Общие подделки для тестов голоса: настройки LiveKit, подписанные вебхуки, комнаты в памяти."""

import base64
import hashlib
import json
import time
import unittest
from unittest import mock

from jose import jwt

from app.core.config import settings

LK = {
    "LIVEKIT_URL": "http://livekit:7880",
    "LIVEKIT_PUBLIC_URL": "wss://example.test/livekit",
    "LIVEKIT_API_KEY": "APItest",
    "LIVEKIT_API_SECRET": "s" * 40,
}


def configure_livekit(test: unittest.TestCase) -> None:
    patcher = mock.patch.multiple(settings, **LK)
    patcher.start()
    test.addCleanup(patcher.stop)


def signed_webhook(event: dict, secret: str = LK["LIVEKIT_API_SECRET"]) -> tuple[bytes, str]:
    body = json.dumps(event).encode()
    sha = base64.b64encode(hashlib.sha256(body).digest()).decode()
    token = jwt.encode(
        {"iss": LK["LIVEKIT_API_KEY"], "sha256": sha, "exp": int(time.time()) + 300},
        secret,
        algorithm="HS256",
    )
    return body, token


class FakeRoomService:
    """Вместо настоящего LiveKit: комнаты и участники в памяти, вызовы записываются."""

    def __init__(self):
        self.rooms: dict[str, set[str]] = {}
        self.calls: list[tuple] = []

    async def create_room(self, name, *, max_participants, empty_timeout=120):
        self.calls.append(("create_room", name, max_participants))
        self.rooms.setdefault(name, set())

    async def list_participants(self, room):
        return [{"identity": i} for i in self.rooms.get(room, set())]

    async def remove_participant(self, room, identity):
        self.calls.append(("remove_participant", room, identity))
        self.rooms.get(room, set()).discard(identity)

    async def set_can_publish(self, room, identity, can_publish):
        self.calls.append(("set_can_publish", room, identity, can_publish))

    async def delete_room(self, room):
        self.calls.append(("delete_room", room))
        self.rooms.pop(room, None)

    async def list_rooms(self):
        return [{"name": name} for name in self.rooms]

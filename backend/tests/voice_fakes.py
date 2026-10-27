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
        # (room, identity) -> опубликованные треки, как их отдаёт ListParticipants.
        self.tracks: dict[tuple[str, str], list[dict]] = {}
        # Метаданные комнат и время входа участников (секунды), как их отдаёт LiveKit.
        self.metadata: dict[str, str] = {}
        self.joined: dict[tuple[str, str], int] = {}

    async def create_room(self, name, *, max_participants, empty_timeout=120):
        self.calls.append(("create_room", name, max_participants))
        self.rooms.setdefault(name, set())

    async def list_participants(self, room):
        return [
            {"identity": i, "tracks": self.tracks.get((room, i), []), "joined_at": str(self.joined.get((room, i), 0))}
            for i in self.rooms.get(room, set())
        ]

    async def remove_participant(self, room, identity):
        self.calls.append(("remove_participant", room, identity))
        self.rooms.get(room, set()).discard(identity)

    async def update_publish_sources(self, room, identity, sources):
        self.calls.append(("update_publish_sources", room, identity, list(sources)))

    def sources(self, room, identity):
        """Последние выданные участнику источники (None — права не меняли)."""
        for call in reversed(self.calls):
            if call[0] == "update_publish_sources" and call[1:3] == (room, identity):
                return call[3]
        return None

    async def delete_room(self, room):
        self.calls.append(("delete_room", room))
        self.rooms.pop(room, None)

    async def update_room_metadata(self, room, metadata):
        self.calls.append(("update_room_metadata", room, metadata))
        self.metadata[room] = metadata

    async def list_rooms(self):
        return [{"name": name, "metadata": self.metadata.get(name, "")} for name in self.rooms]

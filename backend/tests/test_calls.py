"""Unit tests for call signaling helpers."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from app.ws import calls
from app.ws.calls import _media_from_payload
from app.ws.hub import manager


class TestCallMedia(unittest.TestCase):
    def test_default_audio(self):
        self.assertEqual(_media_from_payload({}), "audio")

    def test_audio_video(self):
        self.assertEqual(
            _media_from_payload({"media": {"audio": True, "video": True}}),
            "audio_video",
        )

    def test_video_only(self):
        self.assertEqual(
            _media_from_payload({"media": {"audio": False, "video": True}}),
            "video",
        )


class FakeWs:
    def __init__(self, name: str):
        self.name = name
        self.sent: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    def types(self) -> list[str]:
        return [e["type"] for e in self.sent]

    def __repr__(self) -> str:
        return f"FakeWs({self.name})"


class TestMultiDeviceCalls(unittest.IsolatedAsyncioTestCase):
    """Callee is online on a phone and a computer; the call must live on the device that answered."""

    async def asyncSetUp(self):
        self.statuses: list[tuple[str, str]] = []

        async def allowed(*_args):
            return True

        async def nothing(*_args, **_kwargs):
            return None

        async def status(call_id, value, **_kwargs):
            self.statuses.append((call_id, value))

        async def name(_user_id):
            return "Алиса"

        for target, fake in (
            ("_assert_direct_member", allowed),
            ("_persist_create", nothing),
            ("_persist_status", status),
            ("send_push_to_user", nothing),
            ("user_has_push", allowed),
            ("_username", name),
        ):
            patcher = mock.patch.object(calls, target, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.alice = FakeWs("alice")
        self.bob_phone = FakeWs("bob-phone")
        self.bob_pc = FakeWs("bob-pc")
        manager.user_connections.clear()
        manager.user_connections["alice"] = [self.alice]
        manager.user_connections["bob"] = [self.bob_phone, self.bob_pc]
        self.addCleanup(manager.user_connections.clear)
        self.addCleanup(calls._active.clear)
        self.addCleanup(calls._user_call.clear)

        await calls.handle_call_event(
            {"type": "call_invite", "call_id": "c1", "chat_id": "chat", "callee_id": "bob"},
            "alice",
            self.alice,
        )

    async def accept_on_phone(self):
        await calls.handle_call_event({"type": "call_accept", "call_id": "c1"}, "bob", self.bob_phone)

    async def test_both_devices_ring(self):
        self.assertIn("call_invite", self.bob_phone.types())
        self.assertIn("call_invite", self.bob_pc.types())

    async def test_other_device_is_told_the_call_was_answered_elsewhere(self):
        await self.accept_on_phone()
        self.assertEqual(self.bob_phone.sent[-1]["type"], "call_accept")
        self.assertEqual(self.bob_pc.sent[-1]["type"], "call_hangup")
        self.assertEqual(self.bob_pc.sent[-1]["reason"], "answered_elsewhere")
        self.assertEqual(self.alice.sent[-1]["type"], "call_accept")

    async def test_signaling_reaches_only_the_answering_device(self):
        await self.accept_on_phone()
        pc_before = len(self.bob_pc.sent)
        await calls.handle_call_event(
            {"type": "call_offer", "call_id": "c1", "sdp": {"type": "offer", "sdp": "x"}},
            "alice",
            self.alice,
        )
        await calls.handle_call_event(
            {"type": "call_ice", "call_id": "c1", "candidate": {"candidate": "y"}}, "alice", self.alice
        )
        self.assertEqual(self.bob_phone.types()[-2:], ["call_offer", "call_ice"])
        self.assertEqual(len(self.bob_pc.sent), pc_before)

    async def test_other_device_cannot_answer_or_hang_up(self):
        await self.accept_on_phone()
        alice_before = len(self.alice.sent)
        await calls.handle_call_event(
            {"type": "call_answer", "call_id": "c1", "sdp": {"type": "answer", "sdp": "z"}},
            "bob",
            self.bob_pc,
        )
        await calls.handle_call_event({"type": "call_hangup", "call_id": "c1"}, "bob", self.bob_pc)
        await calls.handle_call_event({"type": "call_reject", "call_id": "c1"}, "bob", self.bob_pc)
        self.assertEqual(len(self.alice.sent), alice_before)
        self.assertIsNotNone(calls.get_active_call("c1"))

    async def test_closing_the_other_device_keeps_the_call(self):
        await self.accept_on_phone()
        manager.disconnect(self.bob_pc, "bob")
        await calls.on_user_offline("bob", self.bob_pc)
        self.assertIsNotNone(calls.get_active_call("c1"))

    async def test_losing_the_answering_device_ends_the_call(self):
        await self.accept_on_phone()
        manager.disconnect(self.bob_phone, "bob")
        await calls.on_user_offline("bob", self.bob_phone)
        self.assertIsNone(calls.get_active_call("c1"))
        self.assertEqual(self.alice.sent[-1]["type"], "call_hangup")
        self.assertEqual(self.alice.sent[-1]["reason"], "disconnect")

    async def test_hangup_from_the_answering_device_ends_the_call(self):
        await self.accept_on_phone()
        await calls.handle_call_event({"type": "call_hangup", "call_id": "c1"}, "bob", self.bob_phone)
        self.assertIsNone(calls.get_active_call("c1"))
        self.assertIn(("c1", "ended"), self.statuses)

    async def test_any_device_can_decline_while_ringing(self):
        await calls.handle_call_event({"type": "call_reject", "call_id": "c1"}, "bob", self.bob_pc)
        self.assertIsNone(calls.get_active_call("c1"))
        self.assertEqual(self.alice.sent[-1]["type"], "call_reject")


if __name__ == "__main__":
    unittest.main()

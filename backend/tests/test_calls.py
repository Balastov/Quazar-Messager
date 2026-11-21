"""Unit tests for call signaling helpers."""

from __future__ import annotations

import asyncio
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
        self.closed = False

    async def close(self, code: int = 1000) -> None:
        self.closed = True

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
        self.app_pushes: list[tuple[str, dict]] = []
        self.pushes: list[tuple[str, dict]] = []

        async def allowed(*_args):
            return True

        async def app_push(user_id, payload):
            self.app_pushes.append((user_id, payload))

        async def push(user_id, payload):
            self.pushes.append((user_id, payload))

        async def nothing(*_args, **_kwargs):
            return None

        async def status(call_id, value, **_kwargs):
            self.statuses.append((call_id, value))

        async def name(_user_id):
            return "Алиса"

        self.blocks = (False, False)

        async def block_state(*_args):
            return self.blocks

        for target, fake in (
            ("_assert_direct_member", allowed),
            ("_persist_create", nothing),
            ("_persist_status", status),
            ("send_push_to_user", push),
            ("send_app_push_to_user", app_push),
            ("user_has_push", allowed),
            ("_username", name),
            ("block_state", block_state),
            ("_persist_missed", nothing),
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

        grace = mock.patch.object(calls, "_reconnect_grace", lambda: 0.05)
        grace.start()
        self.addCleanup(grace.stop)

        await calls.handle_call_event(
            {"type": "call_invite", "call_id": "c1", "chat_id": "chat", "callee_id": "bob"},
            "alice",
            self.alice,
        )

    async def accept_on_phone(self):
        await calls.handle_call_event(
            {"type": "call_accept", "call_id": "c1", "device_id": "phone-tab"}, "bob", self.bob_phone
        )

    async def drop(self, user_id: str, ws: FakeWs):
        manager.disconnect(ws, user_id)
        await calls.on_user_offline(user_id, ws)

    async def come_back(self, user_id: str, name: str, device_id: str | None = None) -> FakeWs:
        ws = FakeWs(name)
        manager.user_connections.setdefault(user_id, []).append(ws)
        payload = {"type": "call_resume", "call_id": "c1"}
        if device_id:
            payload["device_id"] = device_id
        await calls.handle_call_event(payload, user_id, ws)
        return ws

    def cancels(self):
        return [(uid, p["call_id"]) for uid, p in self.app_pushes if p["type"] == "call_cancel"]

    async def test_incoming_push_carries_the_ring_deadline_and_a_decline_key(self):
        _, push = self.pushes[-1]
        self.assertEqual(push["type"], "incoming_call")
        self.assertEqual(push["decline_token"], calls.decline_token("c1", "bob"))
        self.assertGreater(push["ends_at_ms"], 0)

    async def test_the_phone_stops_ringing_whenever_the_call_stops_ringing(self):
        await self.accept_on_phone()
        self.assertEqual(self.cancels(), [("bob", "c1")])

    async def test_caller_hangup_and_reject_stop_the_phone_ringing(self):
        await calls.handle_call_event({"type": "call_hangup", "call_id": "c1"}, "alice", self.alice)
        self.assertEqual(self.cancels(), [("bob", "c1")])
        # Сброс уже идущего разговора — экран звонка давно погас, слать нечего.
        self.app_pushes.clear()
        await calls.handle_call_event({"type": "call_invite", "call_id": "c2", "chat_id": "chat", "callee_id": "bob"}, "alice", self.alice)
        await calls.handle_call_event({"type": "call_reject", "call_id": "c2"}, "bob", self.bob_pc)
        self.assertEqual(self.cancels(), [("bob", "c2")])

    async def test_decline_from_the_lock_screen_needs_this_calls_key(self):
        self.assertFalse(await calls.decline_from_push("c1", "0" * 64))
        self.assertFalse(await calls.decline_from_push("c1", calls.decline_token("c1", "alice")))
        self.assertIsNotNone(calls.get_active_call("c1"))
        self.assertTrue(await calls.decline_from_push("c1", calls.decline_token("c1", "bob")))
        self.assertIsNone(calls.get_active_call("c1"))
        self.assertIn("call_reject", self.alice.types())
        self.assertIn(("c1", "rejected"), self.statuses)
        self.assertEqual(self.cancels(), [("bob", "c1")])
        # Повторно (звонок уже кончился) — просто нет.
        self.assertFalse(await calls.decline_from_push("c1", calls.decline_token("c1", "bob")))

    async def test_ring_timeout_stops_the_phone(self):
        with mock.patch.object(calls.settings, "CALL_RING_TIMEOUT_SEC", 0):
            with mock.patch.object(calls.asyncio, "sleep", mock.AsyncMock()):
                await calls._ring_timeout("c1")
        self.assertEqual(self.cancels(), [("bob", "c1")])

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

    async def test_media_change_reaches_the_peer_device(self):
        await self.accept_on_phone()
        await calls.handle_call_event(
            {"type": "call_media", "call_id": "c1", "video": True, "screen": "yes"}, "alice", self.alice
        )
        event = self.bob_phone.sent[-1]
        self.assertEqual(
            (event["type"], event["video"], event["screen"], event["from_user_id"]),
            ("call_media", True, False, "alice"),
        )

    async def test_screen_audio_flag_is_boolean_and_only_valid_during_screen_share(self):
        await self.accept_on_phone()
        for screen, sound, expected in ((True, True, True), (False, True, False), (True, "yes", False)):
            await calls.handle_call_event(
                {"type": "call_media", "call_id": "c1", "video": False, "screen": screen, "screen_audio": sound},
                "alice", self.alice,
            )
            self.assertEqual(self.bob_phone.sent[-1]["screen_audio"], expected)

    async def test_call_to_someone_who_blocked_you_looks_offline(self):
        self.blocks = (False, True)
        bob_before = len(self.bob_phone.sent)
        await calls.handle_call_event(
            {"type": "call_invite", "call_id": "c2", "chat_id": "chat2", "callee_id": "bob"},
            "carol",
            None,
        )
        self.assertEqual(len(self.bob_phone.sent), bob_before)
        self.assertIsNone(calls.get_active_call("c2"))

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

    async def test_losing_the_answering_device_ends_the_call_after_the_grace(self):
        await self.accept_on_phone()
        await self.drop("bob", self.bob_phone)
        self.assertIsNotNone(calls.get_active_call("c1"))
        self.assertEqual(self.alice.sent[-1], {"type": "call_reconnecting", "call_id": "c1", "user_id": "bob"})
        await asyncio.sleep(0.1)
        self.assertIsNone(calls.get_active_call("c1"))
        self.assertEqual(self.alice.sent[-1]["type"], "call_hangup")
        self.assertEqual(self.alice.sent[-1]["reason"], "disconnect")
        self.assertIn(("c1", "ended"), self.statuses)

    async def test_device_that_comes_back_in_time_keeps_the_call(self):
        await self.accept_on_phone()
        await self.drop("bob", self.bob_phone)
        phone = await self.come_back("bob", "bob-phone-2")
        self.assertEqual(phone.sent[-1], {"type": "call_resumed", "call_id": "c1"})
        self.assertEqual(self.alice.sent[-1], {"type": "call_reconnected", "call_id": "c1", "user_id": "bob"})
        await asyncio.sleep(0.1)
        self.assertIsNotNone(calls.get_active_call("c1"))
        # Signaling now goes to the new connection.
        await calls.handle_call_event(
            {"type": "call_offer", "call_id": "c1", "sdp": {"type": "offer", "sdp": "restart"}},
            "alice",
            self.alice,
        )
        self.assertEqual(phone.sent[-1]["type"], "call_offer")

    async def test_caller_can_come_back_too(self):
        await self.accept_on_phone()
        await self.drop("alice", self.alice)
        self.assertEqual(self.bob_phone.sent[-1]["type"], "call_reconnecting")
        alice = await self.come_back("alice", "alice-2")
        self.assertEqual(alice.sent[-1]["type"], "call_resumed")
        self.assertEqual(self.bob_phone.sent[-1]["type"], "call_reconnected")

    async def test_same_device_resumes_before_its_old_connection_times_out(self):
        await self.accept_on_phone()
        phone = await self.come_back("bob", "bob-phone-2", device_id="phone-tab")
        self.assertEqual(phone.sent[-1]["type"], "call_resumed")
        self.assertTrue(self.bob_phone.closed)
        await self.drop("bob", self.bob_phone)  # the old connection finally goes away
        self.assertIsNotNone(calls.get_active_call("c1"))
        self.assertNotIn("call_reconnecting", self.alice.types())

    async def test_another_device_cannot_take_over_a_live_call(self):
        await self.accept_on_phone()
        await calls.handle_call_event(
            {"type": "call_resume", "call_id": "c1", "device_id": "pc-tab"}, "bob", self.bob_pc
        )
        self.assertEqual(self.bob_pc.sent[-1]["type"], "call_resume_failed")
        self.assertFalse(self.bob_phone.closed)

    async def test_resume_of_a_finished_call_fails(self):
        await self.accept_on_phone()
        await calls.handle_call_event({"type": "call_hangup", "call_id": "c1"}, "alice", self.alice)
        phone = await self.come_back("bob", "bob-phone-2")
        self.assertEqual(phone.sent[-1]["type"], "call_resume_failed")

    async def test_heartbeat_watch_applies_only_to_the_call_connection(self):
        self.assertFalse(calls.ws_in_active_call("bob", self.bob_phone))  # still ringing
        await self.accept_on_phone()
        self.assertTrue(calls.ws_in_active_call("bob", self.bob_phone))
        self.assertFalse(calls.ws_in_active_call("bob", self.bob_pc))
        self.assertTrue(calls.ws_in_active_call("alice", self.alice))

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

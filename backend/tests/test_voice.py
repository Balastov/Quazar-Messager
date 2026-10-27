"""Голос на Планетах: токены и вебхуки LiveKit, вход с учётом вместимости, модерация."""

import base64
import hashlib
import json
import time
import unittest
from unittest import mock

import httpx
from jose import jwt

from app.api import stars as api
from app.api import voice as voice_api
from app.core import livekit, voice
from app.core.config import settings
from app.schemas.star import CreateChannel, UpdateChannel, UpdateRolePermissions
from tests.stars_base import StarsTestBase
from tests.voice_fakes import LK, FakeRoomService, configure_livekit, signed_webhook

class TestTokensAndWebhooks(unittest.TestCase):
    def setUp(self):
        configure_livekit(self)

    def test_participant_token(self):
        token = livekit.participant_token(
            room="planet-1", identity="u1", name="Аня", metadata={"star_id": "s1"}
        )
        claims = jwt.decode(token, LK["LIVEKIT_API_SECRET"], algorithms=["HS256"])
        self.assertEqual(claims["iss"], LK["LIVEKIT_API_KEY"])
        self.assertEqual(claims["sub"], "u1")
        self.assertEqual(claims["video"]["room"], "planet-1")
        self.assertTrue(claims["video"]["roomJoin"])
        self.assertFalse(claims["video"].get("roomAdmin", False))
        # Экран показывать нельзя, пока бэкенд не выдаст слот.
        self.assertEqual(claims["video"]["canPublishSources"], ["microphone"])
        self.assertLessEqual(claims["exp"] - time.time(), livekit.CLIENT_TOKEN_TTL_SEC)

    def test_webhook_signature(self):
        event = {"event": "participant_joined", "room": {"name": "planet-1"}}
        body, token = signed_webhook(event)
        self.assertEqual(livekit.verify_webhook(body, token), event)

        with self.assertRaises(livekit.WebhookError):
            livekit.verify_webhook(body + b" ", token)
        _, forged = signed_webhook(event, secret="x" * 40)
        with self.assertRaises(livekit.WebhookError):
            livekit.verify_webhook(body, forged)
        with self.assertRaises(livekit.WebhookError):
            livekit.verify_webhook(body, None)

    def test_room_naming(self):
        self.assertEqual(voice.channel_from_room(voice.room_name("abc")), "abc")
        self.assertIsNone(voice.channel_from_room("other-room"))


class TestRoomService(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        configure_livekit(self)
        self.requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            if request.url.path.endswith("/RemoveParticipant"):
                return httpx.Response(404, json={"code": "not_found"})
            if request.url.path.endswith("/ListParticipants"):
                return httpx.Response(200, json={"participants": [{"identity": "u1"}]})
            return httpx.Response(200, json={})

        self.service = livekit.RoomService(transport=httpx.MockTransport(handler))

    async def test_calls_twirp_with_admin_token(self):
        await self.service.create_room("planet-1", max_participants=25)
        req = self.requests[0]
        self.assertEqual(req.url.path, "/twirp/livekit.RoomService/CreateRoom")
        self.assertEqual(json.loads(req.content)["max_participants"], 25)
        token = req.headers["Authorization"].removeprefix("Bearer ")
        claims = jwt.decode(token, LK["LIVEKIT_API_SECRET"], algorithms=["HS256"])
        self.assertTrue(claims["video"]["roomAdmin"])

    async def test_parses_participants_and_tolerates_not_found(self):
        self.assertEqual(await self.service.list_participants("planet-1"), [{"identity": "u1"}])
        await self.service.remove_participant("planet-1", "gone")  # 404 — не ошибка


class VoiceApiTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        patcher = mock.patch.object(livekit, "room_service", self.lk)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.star = await self.star_with_roles()
        self.planet = next(c for c in self.star.channels if c.kind == "planet")
        self.satellite = next(c for c in self.star.channels if c.kind == "satellite")

    async def enter(self, user: str, planet=None):
        """Пользователь получил токен и LiveKit сообщил, что он вошёл."""
        planet = planet or self.planet
        out = await self.call(voice_api.join_planet, self.star.id, planet.id, user=user)
        uid = self.users[user].id
        self.lk.rooms.setdefault(out.room, set()).add(uid)
        await voice.handle_webhook(
            {"event": "participant_joined", "room": {"name": out.room}, "participant": {"identity": uid}}
        )
        return out

    def present(self, planet=None) -> set[str]:
        return {p.user_id for p in voice.participants((planet or self.planet).id)}

    async def test_join_returns_token_for_member_only(self):
        out = await self.call(voice_api.join_planet, self.star.id, self.planet.id, user="alice")
        self.assertEqual(out.url, LK["LIVEKIT_PUBLIC_URL"])
        claims = jwt.decode(out.token, LK["LIVEKIT_API_SECRET"], algorithms=["HS256"])
        self.assertEqual(claims["sub"], self.users["alice"].id)
        self.assertEqual(claims["video"]["room"], voice.room_name(self.planet.id))

        await self.expect_error(404, voice_api.join_planet, self.star.id, self.planet.id, user="carol")
        await self.expect_error(400, voice_api.join_planet, self.star.id, self.satellite.id, user="alice")

    async def test_join_without_livekit_is_503(self):
        with mock.patch.object(settings, "LIVEKIT_URL", ""):
            await self.expect_error(503, voice_api.join_planet, self.star.id, self.planet.id, user="alice")

    async def test_capacity(self):
        small = await self.call(
            api.create_channel, self.star.id, CreateChannel(kind="planet", name="Двое", capacity=2), user="owner"
        )
        await self.enter("alice", small)
        await self.enter("bob", small)
        err = await self.expect_error(409, voice_api.join_planet, self.star.id, small.id, user="mod")
        self.assertIn("2 из 2", err.detail)
        # Кто уже внутри (например, переподключается) — проходит.
        await self.call(voice_api.join_planet, self.star.id, small.id, user="alice")

    async def test_presence_is_broadcast_and_in_detail(self):
        self.events.clear()
        await self.enter("alice")
        voice_events = [e for _, e in self.events if e["type"] == "star_voice"]
        self.assertTrue(voice_events)
        self.assertEqual(
            [p["user_id"] for p in voice_events[-1]["participants"]], [self.users["alice"].id]
        )
        detail = await self.call(api.get_star, self.star.id, user="bob")
        self.assertEqual([p.user_id for p in detail.voice[self.planet.id]], [self.users["alice"].id])

        await voice.handle_webhook(
            {
                "event": "participant_left",
                "room": {"name": voice.room_name(self.planet.id)},
                "participant": {"identity": self.users["alice"].id},
            }
        )
        self.assertEqual(self.present(), set())

    async def test_kick_and_ban_remove_from_planet(self):
        await self.enter("alice")
        await self.enter("bob")
        await self.call(api.kick_member, self.star.id, self.users["alice"].id, user="mod")
        await self.call(api.ban_member, self.star.id, self.users["bob"].id, user="admin")
        self.assertEqual(self.present(), set())
        removed = {c[2] for c in self.lk.calls if c[0] == "remove_participant"}
        self.assertEqual(removed, {self.users["alice"].id, self.users["bob"].id})

    async def test_moderator_mutes_and_removes(self):
        await self.enter("alice")
        await self.enter("admin")
        alice, admin = self.users["alice"].id, self.users["admin"].id

        await self.call(
            voice_api.mute_participant, self.star.id, self.planet.id, alice, voice_api.VoiceMute(muted=True), user="mod"
        )
        self.assertEqual(self.lk.sources(voice.room_name(self.planet.id), alice), [])
        self.assertTrue(next(p for p in voice.participants(self.planet.id) if p.user_id == alice).server_muted)

        # Старших модерировать нельзя, участникам — нельзя вообще.
        await self.expect_error(
            403, voice_api.mute_participant, self.star.id, self.planet.id, admin, voice_api.VoiceMute(muted=True), user="mod"
        )
        await self.expect_error(
            403, voice_api.remove_participant, self.star.id, self.planet.id, alice, user="bob"
        )

        await self.call(voice_api.remove_participant, self.star.id, self.planet.id, alice, user="mod")
        self.assertNotIn(alice, self.present())

    # --- Показ экрана ---------------------------------------------------------

    def sharing(self, planet=None) -> set[str]:
        return {p.user_id for p in voice.participants((planet or self.planet).id) if p.screen_sharing}

    async def track_event(self, kind: str, user: str, sid: str, source="SCREEN_SHARE"):
        await voice.handle_webhook(
            {
                "event": kind,
                "room": {"name": voice.room_name(self.planet.id)},
                "participant": {"identity": self.users[user].id},
                "track": {"sid": sid, "source": source, "type": "VIDEO"},
            }
        )

    async def test_screen_share_one_at_a_time(self):
        await self.enter("alice")
        await self.enter("bob")
        alice = self.users["alice"].id
        room = voice.room_name(self.planet.id)

        self.events.clear()
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="alice")
        self.assertEqual(self.sharing(), {alice})
        self.assertEqual(
            self.lk.sources(room, alice), ["MICROPHONE", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]
        )
        last = [e for _, e in self.events if e["type"] == "star_voice"][-1]
        self.assertEqual([p["user_id"] for p in last["participants"] if p["screen_sharing"]], [alice])
        detail = await self.call(api.get_star, self.star.id, user="bob")
        self.assertTrue(next(p for p in detail.voice[self.planet.id] if p.user_id == alice).screen_sharing)

        # Повторный запрос того же человека — не ошибка; второй — ждёт.
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="alice")
        err = await self.expect_error(409, voice_api.start_screen, self.star.id, self.planet.id, user="bob")
        self.assertIn("alice", err.detail)

        await self.call(voice_api.stop_my_screen, self.star.id, self.planet.id, user="alice")
        self.assertEqual(self.sharing(), set())
        self.assertEqual(self.lk.sources(room, alice), ["MICROPHONE"])
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="bob")
        self.assertEqual(self.sharing(), {self.users["bob"].id})

    async def test_screen_share_needs_presence(self):
        err = await self.expect_error(409, voice_api.start_screen, self.star.id, self.planet.id, user="alice")
        self.assertEqual(err.detail, "Сначала посетите Планету")
        await self.expect_error(404, voice_api.start_screen, self.star.id, self.planet.id, user="carol")
        await self.expect_error(400, voice_api.start_screen, self.star.id, self.satellite.id, user="alice")

    async def test_moderators_stop_others_screen(self):
        for user in ("alice", "bob", "admin"):
            await self.enter(user)
        alice, admin = self.users["alice"].id, self.users["admin"].id

        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="alice")
        # Обычный участник чужой показ не останавливает.
        await self.expect_error(403, voice_api.stop_screen_of, self.star.id, self.planet.id, alice, user="bob")
        await self.call(voice_api.stop_screen_of, self.star.id, self.planet.id, alice, user="mod")
        self.assertEqual(self.sharing(), set())
        self.assertEqual(self.lk.sources(voice.room_name(self.planet.id), alice), ["MICROPHONE"])

        # Старших по роли не останавливают; владелец может остановить админа.
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="admin")
        await self.expect_error(403, voice_api.stop_screen_of, self.star.id, self.planet.id, admin, user="mod")
        await self.call(voice_api.stop_screen_of, self.star.id, self.planet.id, admin, user="owner")
        self.assertEqual(self.sharing(), set())

    async def test_server_mute_keeps_screen(self):
        await self.enter("alice")
        alice = self.users["alice"].id
        room = voice.room_name(self.planet.id)
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="alice")
        await self.call(
            voice_api.mute_participant, self.star.id, self.planet.id, alice, voice_api.VoiceMute(muted=True), user="mod"
        )
        self.assertEqual(self.lk.sources(room, alice), ["SCREEN_SHARE", "SCREEN_SHARE_AUDIO"])
        await self.call(voice_api.stop_my_screen, self.star.id, self.planet.id, user="alice")
        # Микрофон остаётся выключенным модератором.
        self.assertEqual(self.lk.sources(room, alice), [])

    async def test_screen_released_by_webhooks(self):
        await self.enter("alice")
        await self.enter("bob")
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="alice")
        await self.track_event("track_published", "alice", "TR_screen")
        # Микрофон и чужие sid слот не освобождают.
        await self.track_event("track_unpublished", "alice", "TR_mic", source="MICROPHONE")
        await self.track_event("track_unpublished", "alice", "TR_old")
        self.assertEqual(self.sharing(), {self.users["alice"].id})
        # Нажали «Остановить показ» в браузере.
        await self.track_event("track_unpublished", "alice", "TR_screen")
        self.assertEqual(self.sharing(), set())

        # Ушёл с Планеты — слот свободен.
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="bob")
        await voice.handle_webhook(
            {
                "event": "participant_left",
                "room": {"name": voice.room_name(self.planet.id)},
                "participant": {"identity": self.users["bob"].id},
            }
        )
        self.assertEqual(self.sharing(), set())
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="alice")

    async def test_resync_restores_screen(self):
        await self.enter("alice")
        room = voice.room_name(self.planet.id)
        self.lk.tracks[(room, self.users["alice"].id)] = [
            {"sid": "TR_mic", "source": 2},
            {"sid": "TR_screen", "source": 3},
        ]
        voice.reset()
        await voice.resync()
        self.assertEqual(self.sharing(), {self.users["alice"].id})

    # --- «Только слушать» ----------------------------------------------------

    async def test_listen_only_token_has_no_microphone(self):
        quiet = await self.call(
            api.create_channel,
            self.star.id,
            CreateChannel(kind="planet", name="Кинозал", listen_only=True),
            user="owner",
        )
        self.assertTrue(quiet.listen_only)
        out = await self.call(voice_api.join_planet, self.star.id, quiet.id, user="alice")
        video = jwt.decode(out.token, LK["LIVEKIT_API_SECRET"], algorithms=["HS256"])["video"]
        self.assertFalse(video["canPublish"])
        self.assertEqual(video["canPublishSources"], [])
        # Обычная Планета — как раньше.
        out = await self.call(voice_api.join_planet, self.star.id, self.planet.id, user="alice")
        video = jwt.decode(out.token, LK["LIVEKIT_API_SECRET"], algorithms=["HS256"])["video"]
        self.assertEqual(video["canPublishSources"], ["microphone"])

    async def test_switching_listen_only_updates_everyone_inside(self):
        await self.enter("alice")
        await self.enter("bob")
        room = voice.room_name(self.planet.id)
        alice, bob = self.users["alice"].id, self.users["bob"].id

        await self.call(api.update_channel, self.star.id, self.planet.id, UpdateChannel(listen_only=True), user="owner")
        self.assertEqual(self.lk.sources(room, alice), [])
        self.assertEqual(self.lk.sources(room, bob), [])
        # Экран показывать можно, микрофон — нет.
        await self.call(voice_api.start_screen, self.star.id, self.planet.id, user="alice")
        self.assertEqual(self.lk.sources(room, alice), ["SCREEN_SHARE", "SCREEN_SHARE_AUDIO"])
        # Мьют модератором в тихой комнате микрофон не вернёт.
        await self.call(
            voice_api.mute_participant, self.star.id, self.planet.id, bob, voice_api.VoiceMute(muted=False), user="mod"
        )
        self.assertEqual(self.lk.sources(room, bob), [])

        await self.call(api.update_channel, self.star.id, self.planet.id, UpdateChannel(listen_only=False), user="owner")
        self.assertEqual(self.lk.sources(room, alice), ["MICROPHONE", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"])
        self.assertEqual(self.lk.sources(room, bob), ["MICROPHONE"])
        # Участники Звезды без права управлять каналами режим не меняют.
        await self.expect_error(
            403, api.update_channel, self.star.id, self.planet.id, UpdateChannel(listen_only=True), user="bob"
        )

    async def test_joining_with_an_old_token_loses_the_microphone(self):
        await self.call(voice_api.join_planet, self.star.id, self.planet.id, user="alice")  # токен с микрофоном
        await self.call(api.update_channel, self.star.id, self.planet.id, UpdateChannel(listen_only=True), user="owner")
        uid = self.users["alice"].id
        room = voice.room_name(self.planet.id)
        await voice.handle_webhook({"event": "participant_joined", "room": {"name": room}, "participant": {"identity": uid}})
        self.assertEqual(self.lk.sources(room, uid), [])

    async def test_voice_moderation_can_be_revoked(self):
        await self.enter("alice")
        await self.call(
            api.update_permissions, self.star.id, UpdateRolePermissions(moderator=["kick"], member=[]), user="owner"
        )
        await self.expect_error(
            403, voice_api.remove_participant, self.star.id, self.planet.id, self.users["alice"].id, user="mod"
        )

    async def test_deleting_planet_closes_room(self):
        await self.enter("alice")
        await self.call(api.delete_channel, self.star.id, self.planet.id, user="owner")
        self.assertIn(("delete_room", voice.room_name(self.planet.id)), self.lk.calls)
        self.assertEqual(self.present(), set())

    async def test_resync_after_restart(self):
        await self.enter("alice")
        voice.reset()
        await voice.resync()
        self.assertEqual(self.present(), {self.users["alice"].id})

    # --- Время активности Планеты ----------------------------------------------

    async def leave(self, user: str) -> None:
        await voice.handle_webhook(
            {
                "event": "participant_left",
                "room": {"name": voice.room_name(self.planet.id)},
                "participant": {"identity": self.users[user].id},
            }
        )

    async def test_active_since_runs_from_first_in_to_last_out(self):
        self.events.clear()
        await self.enter("alice")
        since = voice.active_since(self.planet.id)
        self.assertIsNotNone(since)
        last = [e for _, e in self.events if e["type"] == "star_voice"][-1]
        self.assertEqual(last["active_since"], since.isoformat())
        room = voice.room_name(self.planet.id)
        self.assertEqual(json.loads(self.lk.metadata[room]), {"active_since": since.isoformat()})

        # Второй вошёл, первый ушёл — счётчик тот же.
        await self.enter("bob")
        await self.leave("alice")
        self.assertEqual(voice.active_since(self.planet.id), since)
        detail = await self.call(api.get_star, self.star.id, user="bob")
        self.assertEqual(detail.voice_since, {self.planet.id: since})
        self.assertEqual(len([c for c in self.lk.calls if c[0] == "update_room_metadata"]), 1)

        # Последний ушёл — счётчик остановлен; следующий вход начинает заново.
        self.events.clear()
        await self.leave("bob")
        self.assertIsNone(voice.active_since(self.planet.id))
        self.assertIsNone([e for _, e in self.events if e["type"] == "star_voice"][-1]["active_since"])
        detail = await self.call(api.get_star, self.star.id, user="bob")
        self.assertEqual(detail.voice_since, {})
        await self.enter("alice")
        self.assertGreater(voice.active_since(self.planet.id), since)

    async def test_resync_keeps_active_since(self):
        await self.enter("alice")
        since = voice.active_since(self.planet.id)
        voice.reset()
        await voice.resync()
        self.assertEqual(voice.active_since(self.planet.id), since)

    async def test_resync_without_metadata_uses_earliest_join(self):
        await self.enter("alice")
        await self.enter("bob")
        room = voice.room_name(self.planet.id)
        self.lk.metadata.pop(room)
        self.lk.joined[(room, self.users["alice"].id)] = 1_700_000_100
        self.lk.joined[(room, self.users["bob"].id)] = 1_700_000_000
        voice.reset()
        await voice.resync()
        self.assertEqual(voice.active_since(self.planet.id).timestamp(), 1_700_000_000)


if __name__ == "__main__":
    unittest.main()

"""Двери комнат: доступ «По приглашениям», «Позвать», стук и ответы, зал ожидания."""

import unittest
from unittest import mock

from app.api import doors as doors_api
from app.api import stars as api
from app.api import voice as voice_api
from app.core import doors, livekit, voice
from app.core import stars as rules
from app.schemas.star import CreateChannel, UpdateChannel, UpdateRolePermissions
from tests.stars_base import StarsTestBase
from tests.voice_fakes import FakeRoomService, configure_livekit


class TestAdmitPermission(unittest.TestCase):
    def test_existing_stars_give_moderators_the_new_right(self):
        legacy = {"moderator": ["invite", "kick"], "member": ["invite"]}
        self.assertIn("admit", rules.normalize_role_permissions(legacy)["moderator"])

    def test_owner_can_turn_it_off(self):
        stored = rules.stored_role_permissions({"moderator": ["invite"], "member": []})
        self.assertFalse(rules.has_perm("moderator", rules.Perm.ADMIT, stored))
        self.assertTrue(rules.has_perm("admin", rules.Perm.ADMIT, stored))


class DoorsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        patcher = mock.patch.object(livekit, "room_service", self.lk)
        patcher.start()
        self.addCleanup(patcher.stop)
        doors.reset()
        self.addCleanup(doors.reset)

        self.pushes: list[tuple[str, dict]] = []

        async def fake_push(user_id, payload):
            self.pushes.append((user_id, payload))
            return 1

        push_patch = mock.patch.object(doors_api, "send_push_to_user", fake_push)
        push_patch.start()
        self.addCleanup(push_patch.stop)

        self.star = await self.star_with_roles("work")
        meeting = next(c for c in self.star.channels if c.room_kind == "meeting")
        self.room = await self.call(
            api.update_channel, self.star.id, meeting.id, UpdateChannel(access="invite"), user="owner"
        )

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def enter(self, user: str, channel_id: str | None = None):
        """Получить токен и «войти» (LiveKit сообщает об этом вебхуком)."""
        channel_id = channel_id or self.room.id
        out = await self.call(voice_api.join_planet, self.star.id, channel_id, user=user)
        self.lk.rooms.setdefault(out.room, set()).add(self.uid(user))
        await voice.handle_webhook(
            {"event": "participant_joined", "room": {"name": out.room}, "participant": {"identity": self.uid(user)}}
        )

    async def leave(self, user: str, channel_id: str):
        room = voice.room_name(channel_id)
        self.lk.rooms.get(room, set()).discard(self.uid(user))
        await voice.handle_webhook(
            {"event": "participant_left", "room": {"name": room}, "participant": {"identity": self.uid(user)}}
        )

    def events_for(self, user: str, kind: str) -> list[dict]:
        return [e for uid, e in self.events if uid == self.uid(user) and e["type"] == kind]

    # --- Доступ ---

    def host(self) -> str | None:
        return voice.host(self.room.id)

    async def test_closed_room_entry_rules(self):
        # В пустую комнату «По приглашениям» входит кто угодно — и становится главным.
        await self.enter("alice")
        self.assertEqual(self.host(), self.uid("alice"))
        presence = voice.presence(self.room.id)
        self.assertEqual([(p["user_id"], p["is_host"]) for p in presence], [(self.uid("alice"), True)])
        # Внутри кто-то есть — участнику предлагают постучаться.
        await self.expect_error(423, voice_api.join_planet, self.star.id, self.room.id, user="bob")
        # Те, у кого есть право впускать, входят без стука.
        await self.enter("mod")
        await self.enter("admin")
        await self.enter("owner")
        self.assertEqual(self.host(), self.uid("alice"))

    async def test_owner_can_take_free_entry_from_moderators(self):
        await self.enter("admin")
        await self.call(
            api.update_permissions, self.star.id,
            UpdateRolePermissions(moderator=["invite"], member=["invite"]), user="owner",
        )
        await self.expect_error(423, voice_api.join_planet, self.star.id, self.room.id, user="mod")

    # --- Стук и ответы ---

    async def test_knock_reaches_room_and_answerers(self):
        await self.enter("admin")
        self.events.clear()
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        self.assertEqual(knock.status, "pending")
        # Видят: кто внутри (admin) и все, кто может впускать (owner, admin, mod), — не сам стучащий.
        for name in ("admin", "owner", "mod"):
            self.assertTrue(self.events_for(name, "planet_knock"), name)
        self.assertFalse(self.events_for("bob", "planet_knock"))
        # Никого нет в сети — модераторам+ ушёл push.
        self.assertEqual({uid for uid, p in self.pushes if p["door"] == "knock"},
                         {self.uid(n) for n in ("owner", "admin", "mod")})

    async def test_admit_lets_the_knocker_in_once(self):
        await self.enter("mod")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        await self.expect_error(403, doors_api.answer_knock, self.star.id, knock.id,
                                doors_api.AnswerBody(action="admit"), user="bob")

        self.events.clear()
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="mod")
        self.assertEqual(self.events_for("alice", "planet_knock_answer")[-1]["action"], "admit")
        self.assertTrue(self.events_for("mod", "planet_knock_closed"))

        await self.enter("alice")
        self.assertIn(self.uid("alice"), {p.user_id for p in voice.participants(self.room.id)})
        # Пропуск разовый: вышла — снова стучится.
        await self.leave("alice", self.room.id)
        await self.expect_error(423, voice_api.join_planet, self.star.id, self.room.id, user="alice")

    async def test_send_to_waiting_room(self):
        await self.enter("mod")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        self.events.clear()
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="wait"), user="mod")

        answer = self.events_for("alice", "planet_knock_answer")[-1]
        self.assertEqual(answer["action"], "wait")
        detail = await self.call(api.get_star, self.star.id, user="alice")
        lobby = next(c for c in detail.channels if c.room_kind == "lobby")
        self.assertEqual(answer["lobby_channel_id"], lobby.id)
        self.assertEqual((lobby.access, lobby.name), ("open", "Зал ожидания"))
        self.assertIsNotNone(lobby.map_x)  # стоит на карте
        self.assertEqual(doors.get(knock.id).status, "waiting")

        # В зал ожидания вход свободный; ушла из зала — ожидание снято.
        await self.enter("alice", lobby.id)
        self.events.clear()
        await self.leave("alice", lobby.id)
        self.assertIsNone(doors.get(knock.id))
        self.assertTrue(self.events_for("mod", "planet_knock_closed"))

    async def test_admit_from_waiting_room(self):
        await self.enter("mod")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="wait"), user="mod")
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="admin")
        await self.enter("alice")

    async def test_deny(self):
        await self.enter("mod")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="deny"), user="mod")
        self.assertEqual(self.events_for("alice", "planet_knock_answer")[-1]["action"], "deny")
        self.assertIsNone(doors.get(knock.id))
        await self.expect_error(423, voice_api.join_planet, self.star.id, self.room.id, user="alice")

    # --- Главный в комнате «По приглашениям» ---

    async def test_host_answers_knocks_and_invites(self):
        await self.enter("alice")
        self.events.clear()
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="bob")
        # Стук видит главная и те, у кого есть право впускать.
        self.assertTrue(self.events_for("alice", "planet_knock"))
        self.assertTrue(self.events_for("mod", "planet_knock"))
        self.assertFalse(self.events_for("bob", "planet_knock"))
        listed = await self.call(doors_api.list_knocks, self.star.id, user="alice")
        self.assertEqual([k["knock"]["id"] for k in listed], [knock.id])

        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="alice")
        await self.enter("bob")
        # Боб внутри, но не главный: впускать и звать не может.
        await self.join(self.star.id, "carol")
        await self.expect_error(403, doors_api.invite_to_planet, self.star.id, self.room.id,
                                doors_api.InviteBody(user_id=self.uid("carol")), user="bob")
        await self.call(doors_api.invite_to_planet, self.star.id, self.room.id,
                        doors_api.InviteBody(user_id=self.uid("carol")), user="alice")
        await self.enter("carol")

    async def test_member_cannot_answer_without_being_host(self):
        await self.enter("alice")
        await self.call(doors_api.invite_to_planet, self.star.id, self.room.id,
                        doors_api.InviteBody(user_id=self.uid("bob")), user="alice")
        await self.enter("bob")
        await self.join(self.star.id, "carol")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="carol")
        await self.expect_error(403, doors_api.answer_knock, self.star.id, knock.id,
                                doors_api.AnswerBody(action="admit"), user="bob")

    async def test_make_host(self):
        await self.enter("alice")
        await self.call(doors_api.invite_to_planet, self.star.id, self.room.id,
                        doors_api.InviteBody(user_id=self.uid("bob")), user="alice")
        await self.enter("bob")
        # Не главный передать звание не может; передать можно только тому, кто внутри.
        await self.expect_error(403, doors_api.make_host, self.star.id, self.room.id,
                                doors_api.HostBody(user_id=self.uid("bob")), user="bob")
        await self.expect_error(409, doors_api.make_host, self.star.id, self.room.id,
                                doors_api.HostBody(user_id=self.uid("mod")), user="alice")

        await self.join(self.star.id, "carol")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="carol")
        self.events.clear()
        await self.call(doors_api.make_host, self.star.id, self.room.id,
                        doors_api.HostBody(user_id=self.uid("bob")), user="alice")
        self.assertEqual(self.host(), self.uid("bob"))
        voice_events = [e for _, e in self.events if e["type"] == "star_voice"]
        self.assertTrue(any(p["is_host"] and p["user_id"] == self.uid("bob") for p in voice_events[-1]["participants"]))
        # Ждущий стук приходит новому главному, и тот может ответить; прежний — уже нет.
        self.assertEqual(self.events_for("bob", "planet_knock")[-1]["knock"]["id"], knock.id)
        await self.expect_error(403, doors_api.answer_knock, self.star.id, knock.id,
                                doors_api.AnswerBody(action="admit"), user="alice")
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="bob")

    async def test_host_passes_to_the_longest_present_when_leaving(self):
        await self.enter("alice")
        await self.enter("mod")
        await self.call(doors_api.invite_to_planet, self.star.id, self.room.id,
                        doors_api.InviteBody(user_id=self.uid("bob")), user="alice")
        await self.enter("bob")
        await self.leave("alice", self.room.id)
        self.assertEqual(self.host(), self.uid("mod"))
        await self.leave("mod", self.room.id)
        self.assertEqual(self.host(), self.uid("bob"))

    async def test_empty_room_frees_waiting_knocks(self):
        await self.enter("alice")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="bob")
        self.events.clear()
        await self.leave("alice", self.room.id)
        self.assertIsNone(doors.get(knock.id))
        answer = self.events_for("bob", "planet_knock_answer")[-1]
        self.assertEqual(answer["action"], "free")
        self.assertTrue(any(uid == self.uid("bob") and p["door"] == "free" for uid, p in self.pushes))
        await self.enter("bob")
        self.assertEqual(self.host(), self.uid("bob"))

    # --- Личный кабинет ---

    async def cabinet(self, owner: str = "alice"):
        return await self.call(
            api.update_channel, self.star.id, self.room.id,
            UpdateChannel(access="personal", cabinet_owner_id=self.uid(owner)), user="owner",
        )

    async def test_cabinet_needs_an_owner_from_the_star(self):
        await self.expect_error(400, api.update_channel, self.star.id, self.room.id,
                                UpdateChannel(access="personal"), user="owner")
        await self.expect_error(404, api.update_channel, self.star.id, self.room.id,
                                UpdateChannel(access="personal", cabinet_owner_id=self.uid("carol")), user="owner")
        room = await self.cabinet()
        self.assertEqual((room.access, room.cabinet_owner_id), ("personal", self.uid("alice")))
        # Другой режим входа — хозяин кабинета больше не нужен.
        room = await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(access="open"), user="owner")
        self.assertIsNone(room.cabinet_owner_id)

        gaming = await self.make_star("gaming", name="Игры")
        await self.join(gaming.id, "alice")
        await self.expect_error(400, api.create_channel, gaming.id, CreateChannel(
            kind="planet", name="Кабинет", access="personal", cabinet_owner_id=self.uid("alice")), user="owner")

    async def test_cabinet_entry(self):
        await self.cabinet()
        # Без стука — только хозяин; даже владелец Звезды стучится, и в пустой кабинет тоже.
        for name in ("owner", "admin", "mod", "bob"):
            await self.expect_error(423, voice_api.join_planet, self.star.id, self.room.id, user=name)
        self.events.clear()
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="bob")
        # Стук видят хозяин, админы и владелец — модератор нет.
        for name in ("alice", "admin", "owner"):
            self.assertTrue(self.events_for(name, "planet_knock"), name)
        self.assertFalse(self.events_for("mod", "planet_knock"))
        await self.expect_error(403, doors_api.answer_knock, self.star.id, knock.id,
                                doors_api.AnswerBody(action="admit"), user="mod")
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="admin")
        await self.enter("bob")
        await self.enter("alice")
        await self.expect_error(400, doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")

    async def test_cabinet_invites(self):
        await self.cabinet()
        await self.enter("alice")
        await self.call(doors_api.invite_to_planet, self.star.id, self.room.id,
                        doors_api.InviteBody(user_id=self.uid("bob")), user="alice")
        await self.enter("bob")
        # Гость кабинета звать не может, админ внутри — может.
        await self.expect_error(403, doors_api.invite_to_planet, self.star.id, self.room.id,
                                doors_api.InviteBody(user_id=self.uid("mod")), user="bob")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="admin")
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="alice")
        await self.enter("admin")
        await self.call(doors_api.invite_to_planet, self.star.id, self.room.id,
                        doors_api.InviteBody(user_id=self.uid("mod")), user="admin")
        # Хозяин ушёл — кабинет не открывается: стуки ждут хозяина, админов и владельца.
        await self.leave("alice", self.room.id)
        await self.leave("bob", self.room.id)
        await self.leave("admin", self.room.id)
        await self.expect_error(423, voice_api.join_planet, self.star.id, self.room.id, user="bob")

    async def test_knock_refusals(self):
        coworking = next(c for c in self.star.channels if c.room_kind == "coworking")
        await self.expect_error(400, doors_api.knock_on_planet, self.star.id, coworking.id, user="alice")
        await self.expect_error(409, doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        await self.enter("admin")
        await self.expect_error(400, doors_api.knock_on_planet, self.star.id, self.room.id, user="mod")

    async def test_knock_cancel_and_kick(self):
        await self.enter("admin")
        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        await self.call(doors_api.cancel_knock, self.star.id, knock.id, user="alice")
        self.assertIsNone(doors.get(knock.id))

        knock = await self.call(doors_api.knock_on_planet, self.star.id, self.room.id, user="bob")
        await self.call(api.kick_member, self.star.id, self.uid("bob"), user="admin")
        self.assertIsNone(doors.get(knock.id))

    # --- Позвать ---

    async def test_invite_into_open_room_by_anyone_inside(self):
        coworking = next(c for c in self.star.channels if c.room_kind == "coworking")
        await self.expect_error(409, doors_api.invite_to_planet, self.star.id, coworking.id,
                                doors_api.InviteBody(user_id=self.uid("bob")), user="alice")
        await self.enter("alice", coworking.id)
        self.events.clear()
        await self.call(doors_api.invite_to_planet, self.star.id, coworking.id,
                        doors_api.InviteBody(user_id=self.uid("bob")), user="alice")
        invite = self.events_for("bob", "planet_invite")[-1]
        self.assertEqual((invite["from_name"], invite["room_name"]), ("alice", coworking.name))
        self.assertTrue(any(uid == self.uid("bob") and p["door"] == "invite" for uid, p in self.pushes))

    async def test_invite_into_closed_room(self):
        await self.enter("admin")
        await self.call(doors_api.invite_to_planet, self.star.id, self.room.id,
                        doors_api.InviteBody(user_id=self.uid("alice")), user="admin")
        await self.enter("alice")
        # Участник внутри закрытой комнаты сам звать не может — иначе обход двери.
        await self.expect_error(403, doors_api.invite_to_planet, self.star.id, self.room.id,
                                doors_api.InviteBody(user_id=self.uid("bob")), user="alice")

    async def test_online_people_get_no_push(self):
        coworking = next(c for c in self.star.channels if c.room_kind == "coworking")
        await self.enter("alice", coworking.id)
        with mock.patch.dict(doors_api.manager.user_connections, {self.uid("bob"): [object()]}):
            await self.call(doors_api.invite_to_planet, self.star.id, coworking.id,
                            doors_api.InviteBody(user_id=self.uid("bob")), user="alice")
        self.assertFalse(any(uid == self.uid("bob") for uid, _ in self.pushes))

    # --- Зал ожидания в игровой Звезде ---

    async def test_lobby_does_not_count_against_gaming_limit(self):
        gaming = await self.make_star("gaming", name="Игры")
        for i in range(3):
            await self.call(api.create_channel, gaming.id, CreateChannel(kind="planet", name=f"p{i}"), user="owner")
        async with self.Session() as db:
            star = (await db.execute(doors_api.select(doors_api.Star).where(doors_api.Star.id == gaming.id))).scalar_one()
            await doors_api.ensure_lobby(db, star)
        # 1 по умолчанию + 3 = 4 из 5: пятую ещё можно, зал не мешает.
        await self.call(api.create_channel, gaming.id, CreateChannel(kind="planet", name="p5"), user="owner")


if __name__ == "__main__":
    unittest.main()

"""Комната «Сбора группы»: без стука — записавшиеся и организаторы, остальных впускают организаторы.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

from unittest import mock

from sqlalchemy import select

from app.api import doors as doors_api
from app.api import guests as guests_api
from app.api import star_play as play
from app.api import voice as voice_api
from app.core import doors, livekit, voice
from app.core import floors as floors_svc
from app.models.star import StarChannel, StarLfg
from tests.stars_base import StarsTestBase
from tests.voice_fakes import FakeRoomService, configure_livekit


class GatheringTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        doors.reset()
        self.addCleanup(doors.reset)

        async def push(*_args):
            return 1

        for patcher in (
            mock.patch.object(livekit, "room_service", self.lk),
            mock.patch.object(doors_api, "send_push_to_user", push),
            mock.patch.object(play, "send_push_to_user", push),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles("work")
        await self.join(self.star.id, "carol")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")
        async with self.Session() as db:
            self.floor = (await floors_svc.list_floors(db, self.star.id))[0]

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def enter(self, user: str, channel_id: str):
        out = await self.call(voice_api.join_planet, self.star.id, channel_id, user=user)
        self.lk.rooms.setdefault(out.room, set()).add(self.uid(user))
        await voice.handle_webhook(
            {"event": "participant_joined", "room": {"name": out.room}, "participant": {"identity": self.uid(user)}}
        )

    async def started(self, *, admins=("bob",), joined=()) -> StarChannel:
        """Алиса объявляет сбор (организаторы — admins), записываются joined, сбор начинается."""
        await self.call(
            play.create_lfg, self.star.id, self.sat.id,
            play.LfgBody(title="Планёрка", slots=5, admin_ids=[self.uid(n) for n in admins]), user="alice",
        )
        async with self.Session() as db:
            lfg = (await db.execute(select(StarLfg))).scalar_one()
        for name in joined:
            await self.call(play.join_lfg, self.star.id, lfg.id, user=name)
        out = await self.call(play.start_lfg_now, self.star.id, lfg.id, user=admins[0] if admins else "alice")
        async with self.Session() as db:
            return await db.get(StarChannel, out.planet_id)

    async def test_only_signed_up_and_organizers_enter_freely(self):
        planet = await self.started()
        self.assertEqual(planet.access, "gathering")
        self.assertEqual(planet.gathering_members, [self.uid("alice")])
        self.assertEqual(planet.gathering_admins, [self.uid("alice"), self.uid("bob")])
        self.assertEqual(planet.floor_id, self.floor.id)
        # Назначенного организатора тоже позвали, хоть он и не записывался.
        self.assertIn(self.uid("bob"), {uid for uid, e in self.events if e["type"] == "star_lfg_start"})

        # Пустая комната сбора не открыта всем — в отличие от «По приглашениям».
        await self.expect_error(423, voice_api.join_planet, self.star.id, planet.id, user="carol")
        await self.enter("bob", planet.id)
        await self.enter("alice", planet.id)
        # Владелец Звезды впускает куда угодно — и сам входит без стука.
        await self.enter("owner", planet.id)

    async def test_organizers_answer_knocks_and_invite(self):
        planet = await self.started()
        self.events.clear()
        knock = await self.call(doors_api.knock_on_planet, self.star.id, planet.id, user="carol")
        audience = {uid for uid, e in self.events if e["type"] == "planet_knock"}
        self.assertTrue({self.uid("alice"), self.uid("bob")} <= audience)
        self.assertNotIn(self.uid("carol"), audience)

        await self.expect_error(
            403, doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="carol"
        )
        await self.call(doors_api.answer_knock, self.star.id, knock.id, doors_api.AnswerBody(action="admit"), user="bob")
        await self.enter("carol", planet.id)

        # Позвать по своей инициативе — из комнаты, как и в других комнатах.
        await self.enter("bob", planet.id)
        await self.call(doors_api.invite_to_planet, self.star.id, planet.id, doors_api.InviteBody(user_id=self.uid("mod")), user="bob")
        # Записавшийся, но не организатор звать не может.
        await self.expect_error(
            403, doors_api.invite_to_planet, self.star.id, planet.id, doors_api.InviteBody(user_id=self.uid("admin")), user="carol"
        )

    async def test_guest_links_from_organizers_only(self):
        planet = await self.started(joined=("carol",))
        link = await self.call(guests_api.create_guest_link, self.star.id, planet.id, guests_api.CreateGuestLink(hours=1), user="bob")
        self.assertEqual(link.channel_id, planet.id)
        await self.expect_error(
            403, guests_api.create_guest_link, self.star.id, planet.id, guests_api.CreateGuestLink(hours=1), user="carol"
        )

    async def test_author_alone_organizes_by_default_and_organizers_manage(self):
        await self.call(play.create_lfg, self.star.id, self.sat.id, play.LfgBody(title="Ретро", slots=3), user="alice")
        async with self.Session() as db:
            lfg = (await db.execute(select(StarLfg))).scalar_one()
        self.assertIsNone(lfg.admin_ids)
        await self.expect_error(403, play.start_lfg_now, self.star.id, lfg.id, user="bob")
        await self.call(play.join_lfg, self.star.id, lfg.id, user="bob")
        out = await self.call(play.start_lfg_now, self.star.id, lfg.id, user="alice")
        self.assertEqual(out.admins, [])
        async with self.Session() as db:
            planet = await db.get(StarChannel, out.planet_id)
        self.assertEqual(planet.gathering_admins, [self.uid("alice")])
        await self.enter("bob", planet.id)

    async def test_designated_organizer_can_cancel(self):
        await self.call(
            play.create_lfg, self.star.id, self.sat.id,
            play.LfgBody(title="Ретро", slots=3, admin_ids=[self.uid("bob")]), user="alice",
        )
        async with self.Session() as db:
            lfg = (await db.execute(select(StarLfg))).scalar_one()
        await self.expect_error(403, play.cancel_lfg, self.star.id, lfg.id, user="carol")
        out = await self.call(play.cancel_lfg, self.star.id, lfg.id, user="bob")
        self.assertEqual((out.status, out.admins), ("cancelled", [self.uid("bob")]))

    async def test_organizers_come_from_the_floor(self):
        await self.expect_error(
            422, play.create_lfg, self.star.id, self.sat.id,
            play.LfgBody(title="Х", slots=3, admin_ids=["00000000-0000-0000-0000-000000000000"]), user="alice",
        )
        await self.expect_error(
            422, play.create_lfg, self.star.id, self.sat.id,
            play.LfgBody(title="Х", slots=3, admin_ids=[self.uid("alice")]), user="alice",
        )
        async with self.Session() as db:
            closed = await floors_svc.create_floor(db, self.star.id, "2 этаж", access="none")
            await db.commit()
        people = await self.call(play.floor_people_list, self.star.id, closed.id, user="owner")
        self.assertIn(self.uid("owner"), people)
        self.assertNotIn(self.uid("bob"), people)
        # Алиса на закрытый этаж не ходит — ни сбора там, ни списка людей.
        await self.expect_error(403, play.floor_people_list, self.star.id, closed.id, user="alice")
        await self.expect_error(
            422, play.create_lfg, self.star.id, self.sat.id, play.LfgBody(title="Х", slots=3, floor_id=closed.id), user="alice",
        )
        await self.expect_error(
            422, play.create_lfg, self.star.id, self.sat.id,
            play.LfgBody(title="Х", slots=3, floor_id=closed.id, admin_ids=[self.uid("bob")]), user="owner",
        )
        await self.call(
            play.create_lfg, self.star.id, self.sat.id,
            play.LfgBody(title="Х", slots=3, floor_id=closed.id, admin_ids=[self.uid("admin")]), user="owner",
        )
        async with self.Session() as db:
            lfg = (await db.execute(select(StarLfg))).scalar_one()
        # Записаться на сбор этажа, куда нет доступа, нельзя.
        await self.expect_error(403, play.join_lfg, self.star.id, lfg.id, user="bob")

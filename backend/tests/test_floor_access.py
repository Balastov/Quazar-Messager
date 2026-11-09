"""Доступ участников к этажам рабочей Звезды на настоящей PostgreSQL."""

from unittest import mock

from pydantic import ValidationError

from app.api import doors as doors_api
from app.api import guests
from app.api import office as office_api
from app.api import star_work
from app.api import stars as api
from app.api import voice as voice_api
from app.core import livekit, voice
from app.core import floors as floors_svc
from app.models.star import StarFloorAccess
from app.schemas.star import CreateChannel, CreateFloor, SetFloorAccess, UpdateChannel, UpdateRolePermissions
from tests.stars_base import StarsTestBase
from tests.voice_fakes import FakeRoomService, configure_livekit


class FloorAccessTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        patcher = mock.patch.object(livekit, "room_service", self.lk)
        patcher.start()
        self.addCleanup(patcher.stop)
        guests._joins.clear()
        self.star = await self.star_with_roles("work")
        self.closed = await self.call(
            office_api.create_floor, self.star.id, CreateFloor(name="Бухгалтерия", access="none"), user="admin"
        )
        self.room = await self.call(
            api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Сейф", room_kind="meeting", floor_id=self.closed.id), user="owner",
        )

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def visible(self, user: str):
        detail = await self.call(api.get_star, self.star.id, user=user)
        return {f.id for f in detail.floors}, {c.id for c in detail.channels}

    async def test_new_floor_requires_an_explicit_access_choice(self):
        with self.assertRaises(ValidationError):
            CreateFloor(name="3 этаж")
        with self.assertRaises(ValidationError):
            CreateFloor(name="3 этаж", access="some")
        opened = await self.call(office_api.create_floor, self.star.id, CreateFloor(name="Холл", access="all"), user="owner")
        self.assertEqual((opened.access, self.closed.access), ("all", "none"))
        floors, _ = await self.visible("alice")
        self.assertIn(opened.id, floors)

    async def test_closed_floor_is_hidden_and_locked_for_members(self):
        floors, channels = await self.visible("alice")
        self.assertNotIn(self.closed.id, floors)
        self.assertNotIn(self.room.id, channels)
        # Владелец, админ и редактор карты видят все этажи.
        for user in ("owner", "admin"):
            floors, channels = await self.visible(user)
            self.assertIn(self.closed.id, floors)
            self.assertIn(self.room.id, channels)
        floors, _ = await self.visible("mod")
        self.assertNotIn(self.closed.id, floors)
        await self.call(api.update_permissions, self.star.id, UpdateRolePermissions(moderator=["edit_map"], member=[]), user="owner")
        floors, _ = await self.visible("mod")
        self.assertIn(self.closed.id, floors)

        err = await self.expect_error(403, voice_api.join_planet, self.star.id, self.room.id, user="alice")
        self.assertIn("этаж", err.detail)
        await self.expect_error(403, doors_api.knock_on_planet, self.star.id, self.room.id, user="alice")
        await self.expect_error(403, guests.create_guest_link, self.star.id, self.room.id, guests.CreateGuestLink(), user="alice")
        await self.expect_error(403, office_api.get_floor_access, self.star.id, self.closed.id, user="alice")
        await self.call(voice_api.join_planet, self.star.id, self.room.id, user="owner")

    async def test_per_member_access_on_closed_and_open_floors(self):
        self.events.clear()
        out = await self.call(
            office_api.set_floor_access, self.star.id, self.closed.id,
            SetFloorAccess(access="none", user_ids=[self.uid("alice")]), user="owner",
        )
        self.assertEqual(out.user_ids, [self.uid("alice")])
        self.assertIn((self.uid("alice"), {"type": "star_floor_access", "star_id": self.star.id}), self.events)
        self.assertIn(self.closed.id, (await self.visible("alice"))[0])
        self.assertNotIn(self.closed.id, (await self.visible("bob"))[0])
        await self.call(voice_api.join_planet, self.star.id, self.room.id, user="alice")

        # Открыт всем, кроме Боба: новые участники получают доступ по умолчанию.
        out = await self.call(
            office_api.set_floor_access, self.star.id, self.closed.id,
            SetFloorAccess(access="all", user_ids=[self.uid("alice"), self.uid("mod")]), user="admin",
        )
        self.assertEqual(out.access, "all")
        self.assertEqual(set(out.user_ids), {self.uid("alice"), self.uid("mod")})
        self.assertNotIn(self.closed.id, (await self.visible("bob"))[0])
        await self.join(self.star.id, "carol")
        self.assertIn(self.closed.id, (await self.visible("carol"))[0])
        # Владелец и админ в исключения не попадают — им открыто всё.
        async with self.Session() as db:
            stored = {uid for uid, in (await db.execute(StarFloorAccess.__table__.select().with_only_columns(StarFloorAccess.user_id))).all()}
        self.assertEqual(stored, {self.uid("bob")})

        await self.expect_error(
            422, office_api.set_floor_access, self.star.id, self.closed.id,
            SetFloorAccess(access="all", user_ids=["stranger"]), user="owner",
        )

    async def test_losing_access_leaves_the_room(self):
        await self.call(office_api.set_floor_access, self.star.id, self.closed.id,
                        SetFloorAccess(access="none", user_ids=[self.uid("alice")]), user="owner")
        voice._add(self.star.id, self.room.id, self.uid("alice"))
        await self.call(office_api.set_floor_access, self.star.id, self.closed.id,
                        SetFloorAccess(access="none", user_ids=[]), user="owner")
        self.assertNotIn(self.uid("alice"), {p.user_id for p in voice.participants(self.room.id)})
        self.assertIn(("remove_participant", voice.room_name(self.room.id), self.uid("alice")), self.lk.calls)

    async def test_events_of_a_closed_floor_reach_only_its_audience(self):
        self.events.clear()
        await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(name="Касса"), user="owner")
        upserts = {uid for uid, e in self.events if e["type"] == "star_channel_upsert" and e["channel"]["id"] == self.room.id}
        hidden = {uid for uid, e in self.events if e["type"] == "star_channel_deleted" and e["channel_id"] == self.room.id}
        self.assertEqual(upserts, {self.uid("owner"), self.uid("admin")})
        self.assertEqual(hidden, {self.uid("mod"), self.uid("alice"), self.uid("bob")})

        self.events.clear()
        await self.call(office_api.rename_floor, self.star.id, self.closed.id, office_api.UpdateFloor(name="Касса"), user="owner")
        floors = {uid: {f["id"] for f in e["floors"]} for uid, e in self.events if e["type"] == "star_floors"}
        self.assertIn(self.closed.id, floors[self.uid("admin")])
        self.assertNotIn(self.closed.id, floors[self.uid("alice")])

        # Кто сидит в комнате, тоже видно только тем, кому открыт этаж.
        self.events.clear()
        await voice.broadcast(self.star.id, self.room.id)
        self.assertEqual({uid for uid, e in self.events if e["type"] == "star_voice"}, {self.uid("owner"), self.uid("admin")})

        # Комната переехала на открытый этаж — появляется у всех.
        first = next(f for f in (await self.call(api.get_star, self.star.id, user="owner")).floors if f.access == "all")
        self.events.clear()
        await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(floor_id=first.id), user="owner")
        upserts = {uid for uid, e in self.events if e["type"] == "star_channel_upsert" and e["channel"]["id"] == self.room.id}
        self.assertTrue({self.uid("alice"), self.uid("bob")} <= upserts)
        self.assertIn(self.room.id, (await self.visible("alice"))[1])

    async def test_room_on_closed_floor_cannot_be_managed_or_booked_without_access(self):
        await self.call(api.update_permissions, self.star.id, UpdateRolePermissions(moderator=["manage_channels"], member=[]), user="owner")
        await self.expect_error(403, api.update_channel, self.star.id, self.room.id, UpdateChannel(name="x"), user="mod")
        await self.expect_error(403, api.delete_channel, self.star.id, self.room.id, user="mod")
        await self.expect_error(
            403, api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Ещё", floor_id=self.closed.id), user="mod",
        )
        from datetime import datetime, timedelta, timezone

        start = datetime.now(timezone.utc) + timedelta(hours=1)
        body = star_work.BookingBody(title="Отчёт", starts_at=start, ends_at=start + timedelta(hours=1))
        await self.expect_error(403, star_work.create_booking, self.star.id, self.room.id, body, user="alice")
        await self.call(star_work.create_booking, self.star.id, self.room.id, body, user="owner")
        self.assertEqual(len(await self.call(star_work.list_bookings, self.star.id, start=None, end=None, user="admin")), 1)
        self.assertEqual(await self.call(star_work.list_bookings, self.star.id, start=None, end=None, user="alice"), [])

    async def test_invited_member_needs_floor_access(self):
        voice._add(self.star.id, self.room.id, self.uid("owner"))
        await self.expect_error(
            403, doors_api.invite_to_planet, self.star.id, self.room.id, doors_api.InviteBody(user_id=self.uid("bob")), user="owner",
        )

    async def test_guest_links_still_open_only_their_room(self):
        link = await self.call(guests.create_guest_link, self.star.id, self.room.id, guests.CreateGuestLink(), user="owner")
        async with self.Session() as db:
            out = await guests.guest_join(link.code, guests.GuestJoinIn(name="Аудитор"), request=None, db=db)
        self.assertEqual(out.room, voice.room_name(self.room.id))

    async def test_lobby_stays_open_for_everyone(self):
        async with self.Session() as db:
            star = await db.get(api.Star, self.star.id)
            lobby = await doors_api.ensure_lobby(db, star)
            first = (await floors_svc.list_floors(db, self.star.id))[0]
            await floors_svc.set_floor_access(db, star, first, "none", set())
            await db.commit()
        self.assertIsNone(floors_svc.room_floor_id(lobby))
        self.assertIn(lobby.id, (await self.visible("alice"))[1])

    async def test_leaving_forgets_exceptions(self):
        await self.call(office_api.set_floor_access, self.star.id, self.closed.id,
                        SetFloorAccess(access="none", user_ids=[self.uid("alice")]), user="owner")
        await self.call(api.leave_star, self.star.id, user="alice")
        await self.join(self.star.id, "alice")
        self.assertNotIn(self.closed.id, (await self.visible("alice"))[0])

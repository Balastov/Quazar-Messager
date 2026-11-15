"""Гостевая ссылка, открытая под своим аккаунтом: Комната видна в приложении, пока ссылка действует."""

import base64
import json
from datetime import timedelta
from unittest import mock

from app.api import guests
from app.api import office as office_api
from app.api import star_work
from app.api import stars as api
from app.api import voice as voice_api
from app.core import livekit, voice
from app.models.star import StarGuestLink, StarRoomPass
from app.schemas.star import CreateChannel, CreateFloor, SaveLayout, UpdateChannel
from sqlalchemy import func, select
from tests.stars_base import StarsTestBase
from tests.voice_fakes import FakeRoomService, configure_livekit


class GuestPassTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        patcher = mock.patch.object(livekit, "room_service", self.lk)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles("work")
        self.closed = await self.call(
            office_api.create_floor, self.star.id, CreateFloor(name="Бухгалтерия", access="none"), user="admin"
        )
        # Комната по приглашениям: без ссылки сюда только стучатся.
        self.room = await self.call(
            api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Сейф", room_kind="meeting", floor_id=self.closed.id, access="invite"),
            user="owner",
        )
        self.other = await self.call(
            api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Касса", room_kind="meeting", floor_id=self.closed.id), user="owner",
        )
        self.link = await self.call(
            guests.create_guest_link, self.star.id, self.room.id, guests.CreateGuestLink(hours=2), user="owner"
        )

    @staticmethod
    def token_metadata(token: str) -> dict:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return json.loads(claims["metadata"])

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def claim(self, user: str):
        return await self.call(guests.claim_guest_link, self.link.code, user=user)

    async def visible(self, user: str):
        detail = await self.call(api.get_star, self.star.id, user=user)
        return {f.id for f in detail.floors}, {c.id for c in detail.channels}

    async def passes(self) -> int:
        async with self.Session() as db:
            return (await db.execute(select(func.count()).select_from(StarRoomPass))).scalar_one()

    async def expire_link(self):
        async with self.Session() as db:
            link = await db.get(StarGuestLink, self.link.id)
            link.expires_at = guests._now() - timedelta(minutes=1)
            await db.commit()

    async def test_member_without_floor_access_sees_only_the_linked_room(self):
        self.assertNotIn(self.closed.id, (await self.visible("alice"))[0])
        self.events.clear()
        out = await self.claim("alice")
        self.assertEqual((out.star_id, out.channel_id, out.floor_id), (self.star.id, self.room.id, self.closed.id))
        self.assertIn((self.uid("alice"), {"type": "star_floor_access", "star_id": self.star.id}), self.events)

        floors, channels = await self.visible("alice")
        self.assertIn(self.closed.id, floors)
        self.assertIn(self.room.id, channels)
        self.assertNotIn(self.other.id, channels)
        detail = await self.call(api.get_star, self.star.id, user="alice")
        self.assertEqual(detail.my_role, "member")
        self.assertEqual(set(detail.room_passes), {self.room.id})
        # Это не доступ к этажу: в настройках этажа Алисы нет, в соседнюю комнату не войти.
        access = await self.call(office_api.get_floor_access, self.star.id, self.closed.id, user="owner")
        self.assertNotIn(self.uid("alice"), access.user_ids)
        await self.expect_error(403, voice_api.join_planet, self.star.id, self.other.id, user="alice")
        # Ссылка — приглашение: в комнату «по приглашениям» входят без стука.
        await self.call(voice_api.join_planet, self.star.id, self.room.id, user="alice")
        # Бобу ссылку не давали.
        self.assertNotIn(self.room.id, (await self.visible("bob"))[1])

    async def test_claim_is_idempotent_and_not_needed_with_access(self):
        await self.claim("alice")
        await self.claim("alice")
        self.assertEqual(await self.passes(), 1)
        # Владельцу комната и так открыта — пропуск не нужен.
        await self.claim("owner")
        self.assertEqual(await self.passes(), 1)

    async def test_banned_user_cannot_claim(self):
        await self.call(api.ban_member, self.star.id, self.uid("bob"), user="owner")
        await self.expect_error(403, guests.claim_guest_link, self.link.code, user="bob")

    async def test_outsider_sees_the_star_with_only_this_room(self):
        await self.expect_error(404, api.get_star, self.star.id, user="carol")
        await self.claim("carol")

        listed = await self.call(api.list_stars, user="carol")
        self.assertEqual([(s.id, s.my_role) for s in listed], [(self.star.id, "visitor")])
        detail = await self.call(api.get_star, self.star.id, user="carol")
        self.assertEqual(detail.my_role, "visitor")
        self.assertEqual(detail.my_permissions, [])
        self.assertEqual(detail.members, [])
        self.assertEqual([c.id for c in detail.channels], [self.room.id])
        self.assertEqual([f.id for f in detail.floors], [self.closed.id])

        # Участником Карол не стала: остальное в Звезде ей закрыто.
        await self.expect_error(404, star_work.list_bookings, self.star.id, start=None, end=None, user="carol")
        await self.expect_error(403, voice_api.join_planet, self.star.id, self.other.id, user="carol")
        out = await self.call(voice_api.join_planet, self.star.id, self.room.id, user="carol")
        self.assertIs(self.token_metadata(out.token)["visitor"], True)

    async def test_visitor_presence_reaches_room_audience_and_carries_names(self):
        await self.claim("carol")
        voice._add(self.star.id, self.room.id, self.uid("owner"), name="Хозяин")
        voice._add(self.star.id, self.room.id, self.uid("carol"), name="Карол", metadata=json.dumps({"visitor": True}))
        self.events.clear()
        await voice.broadcast(self.star.id, self.room.id)
        audience = {uid for uid, e in self.events if e["type"] == "star_voice"}
        self.assertEqual(audience, {self.uid("owner"), self.uid("admin"), self.uid("carol")})
        people = {p["user_id"]: p for p in next(e for _, e in self.events if e["type"] == "star_voice")["participants"]}
        self.assertEqual(people[self.uid("owner")]["name"], "Хозяин")
        self.assertTrue(people[self.uid("carol")]["visitor"])
        # Посетитель не становится главным в комнате.
        self.assertEqual(voice.host(self.room.id), self.uid("owner"))
        self.assertFalse(await voice.set_host(self.star.id, self.room.id, self.uid("carol")))

    async def test_layout_and_floor_events_show_only_the_linked_room(self):
        await self.claim("alice")
        await self.claim("carol")
        self.events.clear()
        await self.call(office_api.rename_floor, self.star.id, self.closed.id, office_api.UpdateFloor(name="Касса"), user="owner")
        floors = {uid: {f["id"] for f in e["floors"]} for uid, e in self.events if e["type"] == "star_floors"}
        self.assertIn(self.closed.id, floors[self.uid("alice")])
        self.assertEqual(floors[self.uid("carol")], {self.closed.id})
        self.assertNotIn(self.closed.id, floors[self.uid("bob")])

        detail = await self.call(api.get_star, self.star.id, user="owner")
        floor = next(f for f in detail.floors if f.id == self.closed.id)
        rooms = [
            {"channel_id": c.id, "x": c.map_x, "y": c.map_y, "w": c.map_w, "h": c.map_h}
            for c in detail.channels if c.floor_id == self.closed.id
        ]
        self.events.clear()
        await self.call(
            office_api.save_layout, self.star.id, self.closed.id, SaveLayout(version=floor.version, rooms=rooms), user="owner"
        )
        layouts = {uid: [r["channel_id"] for r in e["rooms"]] for uid, e in self.events if e["type"] == "star_layout"}
        self.assertEqual(set(layouts[self.uid("owner")]), {self.room.id, self.other.id})
        self.assertEqual(layouts[self.uid("alice")], [self.room.id])
        self.assertEqual(layouts[self.uid("carol")], [self.room.id])
        self.assertNotIn(self.uid("bob"), layouts)

        # Правка самой комнаты доходит и до посетителя, соседней — нет.
        self.events.clear()
        await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(name="Сейф 2"), user="owner")
        await self.call(api.update_channel, self.star.id, self.other.id, UpdateChannel(name="Касса 2"), user="owner")
        upserts = {(uid, e["channel"]["id"]) for uid, e in self.events if e["type"] == "star_channel_upsert"}
        self.assertIn((self.uid("carol"), self.room.id), upserts)
        self.assertNotIn((self.uid("carol"), self.other.id), upserts)

    async def test_revoking_the_link_removes_access_and_leads_people_out(self):
        await self.claim("alice")
        await self.claim("carol")
        voice._add(self.star.id, self.room.id, self.uid("alice"))
        voice._add(self.star.id, self.room.id, self.uid("carol"), metadata={"visitor": True})
        self.events.clear()
        await self.call(guests.revoke_guest_link, self.star.id, self.link.id, user="owner")

        self.assertEqual(voice.participants(self.room.id), [])
        self.assertIn((self.uid("carol"), {"type": "star_removed", "star_id": self.star.id, "reason": "guest_link"}), self.events)
        self.assertIn((self.uid("alice"), {"type": "star_floor_access", "star_id": self.star.id}), self.events)
        self.assertNotIn(self.closed.id, (await self.visible("alice"))[0])
        await self.expect_error(404, api.get_star, self.star.id, user="carol")
        self.assertEqual(await self.passes(), 0)

    async def test_expired_link_is_swept(self):
        await self.claim("carol")
        voice._add(self.star.id, self.room.id, self.uid("carol"), metadata={"visitor": True})
        await self.expire_link()
        # Пока задача не прошла, ссылка уже не действует.
        self.assertEqual(await self.call(api.list_stars, user="carol"), [])
        await self.expect_error(404, voice_api.join_planet, self.star.id, self.room.id, user="carol")
        self.events.clear()
        async with self.Session() as db:
            self.assertEqual(await guests.expire_room_passes(db), 1)
        self.assertEqual(voice.participants(self.room.id), [])
        self.assertIn((self.uid("carol"), {"type": "star_removed", "star_id": self.star.id, "reason": "guest_link"}), self.events)
        async with self.Session() as db:
            self.assertEqual(await guests.expire_room_passes(db), 0)

    async def test_deleting_the_room_tells_visitors(self):
        await self.claim("carol")
        self.events.clear()
        await self.call(api.delete_channel, self.star.id, self.room.id, user="owner")
        self.assertIn((self.uid("carol"), {"type": "star_removed", "star_id": self.star.id, "reason": "guest_link"}), self.events)
        self.assertEqual(await self.passes(), 0)

    async def test_moderator_can_lead_a_visitor_out(self):
        await self.claim("carol")
        voice._add(self.star.id, self.room.id, self.uid("carol"), metadata={"visitor": True})
        await self.call(voice_api.remove_participant, self.star.id, self.room.id, self.uid("carol"), user="admin")
        self.assertEqual(voice.participants(self.room.id), [])

"""Гостевые ссылки в комнаты рабочей Звезды.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

from unittest import mock

from jose import jwt

from app.api import guests
from app.api import stars as stars_api
from app.api import voice as voice_api
from app.core import livekit, voice
from app.schemas.star import CreateChannel
from tests.stars_base import StarsTestBase
from tests.voice_fakes import LK, FakeRoomService, configure_livekit


class GuestsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        patcher = mock.patch.object(livekit, "room_service", self.lk)
        patcher.start()
        self.addCleanup(patcher.stop)
        guests._joins.clear()
        self.star = await self.star_with_roles(kind="work")
        self.room = next(c for c in self.star.channels if c.room_kind == "meeting")

    async def public(self, fn, *args, **kw):
        async with self.Session() as db:
            return await fn(*args, db=db, **kw)

    async def guest_enters(self, code: str, name: str):
        out = await self.public(guests.guest_join, code, guests.GuestJoinIn(name=name), request=None)
        self.lk.rooms.setdefault(out.room, set()).add(out.identity)
        await voice.handle_webhook({
            "event": "participant_joined", "room": {"name": out.room},
            "participant": {"identity": out.identity, "name": jwt.get_unverified_claims(out.token)["name"]},
        })
        return out

    async def test_link_lifecycle(self):
        link = await self.call(guests.create_guest_link, self.star.id, self.room.id, guests.CreateGuestLink(hours=2), user="alice")
        info = await self.public(guests.guest_info, link.code)
        self.assertEqual(info.room_name, self.room.name)

        out = await self.guest_enters(link.code, "  Пётр   Иванов ")
        claims = jwt.decode(out.token, LK["LIVEKIT_API_SECRET"], algorithms=["HS256"])
        self.assertEqual((claims["name"], claims["video"]["room"]), ("Пётр Иванов (гость)", voice.room_name(self.room.id)))
        self.assertEqual(claims["video"]["canPublishSources"], ["microphone"])
        self.assertTrue(out.identity.startswith(f"guest-{link.id}-"))

        # Гость главным не становится; первый вошедший участник — да.
        self.assertIsNone(voice.host(self.room.id))
        presence = voice.presence(self.room.id)
        self.assertEqual(presence[0]["guest_name"], "Пётр Иванов (гость)")
        self.lk.rooms[out.room].add(self.users["bob"].id)
        await voice.handle_webhook({"event": "participant_joined", "room": {"name": out.room},
                                    "participant": {"identity": self.users["bob"].id}})
        self.assertEqual(voice.host(self.room.id), self.users["bob"].id)

        # Главный может вывести гостя.
        await self.call(voice_api.remove_participant, self.star.id, self.room.id, out.identity, user="bob")
        self.assertIn(("remove_participant", out.room, out.identity), self.lk.calls)

        # Отзыв: ссылка перестаёт работать, гостей по ней выводит.
        again = await self.guest_enters(link.code, "Пётр")
        await self.expect_error(404, guests.revoke_guest_link, self.star.id, link.id, user="carol")  # не в Звезде
        await self.call(guests.revoke_guest_link, self.star.id, link.id, user="alice")
        self.assertIn(("remove_participant", again.room, again.identity), self.lk.calls)
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            await self.public(guests.guest_info, link.code)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_who_can_invite_guests(self):
        cabinet = await self.call(
            stars_api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Кабинет Боба", access="personal", cabinet_owner_id=self.users["bob"].id),
            user="owner",
        )
        await self.expect_error(403, guests.create_guest_link, self.star.id, cabinet.id, guests.CreateGuestLink(), user="alice")
        await self.call(guests.create_guest_link, self.star.id, cabinet.id, guests.CreateGuestLink(), user="bob")
        lobby_or_sat = next(c for c in self.star.channels if c.kind == "satellite")
        await self.expect_error(400, guests.create_guest_link, self.star.id, lobby_or_sat.id, guests.CreateGuestLink(), user="owner")
        gaming = await self.make_star(kind="gaming", name="Игры")
        planet = next(c for c in gaming.channels if c.kind == "planet")
        await self.expect_error(400, guests.create_guest_link, gaming.id, planet.id, guests.CreateGuestLink(), user="owner")
        self.assertEqual(len(await self.call(guests.list_guest_links, self.star.id, cabinet.id, user="alice")), 0)
        self.assertEqual(len(await self.call(guests.list_guest_links, self.star.id, cabinet.id, user="bob")), 1)

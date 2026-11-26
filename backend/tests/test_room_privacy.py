"""«Скрывать, кто в комнате»: рабочие комнаты со стуком на настоящей PostgreSQL."""

from app.api import stars as api
from app.core import voice
from app.schemas.star import CreateChannel, UpdateChannel
from tests.stars_base import StarsTestBase


class RoomPrivacyTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles("work")
        self.room = await self.call(
            api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Переговорная", room_kind="meeting", access="invite", hide_people=True),
            user="owner",
        )
        voice._add(self.star.id, self.room.id, self.uid("alice"))

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def people(self, user: str) -> list[dict]:
        detail = await self.call(api.get_star, self.star.id, user=user)
        return [p.model_dump() for p in detail.voice.get(self.room.id, [])]

    def voice_events(self) -> dict[str, list[dict]]:
        return {uid: e["participants"] for uid, e in self.events if e["type"] == "star_voice" and e["channel_id"] == self.room.id}

    async def test_members_see_only_how_many_are_inside(self):
        self.assertTrue(self.room.hide_people)
        hidden = await self.people("bob")
        self.assertEqual(len(hidden), 1)
        self.assertTrue(hidden[0]["hidden"])
        self.assertTrue(hidden[0]["user_id"].startswith(voice.HIDDEN_PREFIX))
        self.assertNotIn(self.uid("alice"), str(hidden))
        self.assertEqual((hidden[0]["name"], hidden[0]["avatar_url"], hidden[0]["is_host"]), (None, None, False))
        # Владелец, админ, модератор и сама Алиса видят, кто внутри.
        for user in ("owner", "admin", "mod", "alice"):
            people = await self.people(user)
            self.assertEqual([p["user_id"] for p in people], [self.uid("alice")], user)
            self.assertFalse(people[0]["hidden"])

    async def test_live_updates_are_masked_per_recipient(self):
        self.events.clear()
        await voice.broadcast(self.star.id, self.room.id)
        sent = self.voice_events()
        for user in ("owner", "admin", "mod", "alice"):
            self.assertEqual([p["user_id"] for p in sent[self.uid(user)]], [self.uid("alice")], user)
        self.assertEqual([p["hidden"] for p in sent[self.uid("bob")]], [True])
        self.assertNotIn(self.uid("alice"), str(sent[self.uid("bob")]))
        # Боб вошёл — теперь он внутри и видит всех.
        voice._add(self.star.id, self.room.id, self.uid("bob"))
        self.events.clear()
        await voice.broadcast(self.star.id, self.room.id)
        self.assertEqual({p["user_id"] for p in self.voice_events()[self.uid("bob")]}, {self.uid("alice"), self.uid("bob")})

    async def test_only_closed_work_rooms_hide_people(self):
        # Свободный вход — людей видно всем; поменяли дверь — список пересылают сразу.
        self.events.clear()
        await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(access="open"), user="owner")
        self.assertEqual([p["user_id"] for p in self.voice_events()[self.uid("bob")]], [self.uid("alice")])
        self.assertEqual([p["user_id"] for p in await self.people("bob")], [self.uid("alice")])
        # Снова со стуком — снова скрыто; выключили настройку — видно.
        self.events.clear()
        await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(access="invite"), user="owner")
        self.assertTrue(self.voice_events()[self.uid("bob")][0]["hidden"])
        self.events.clear()
        out = await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(hide_people=False), user="admin")
        self.assertFalse(out.hide_people)
        self.assertEqual([p["user_id"] for p in self.voice_events()[self.uid("bob")]], [self.uid("alice")])
        # Изменение, которое видимость не меняет, лишний раз ничего не рассылает.
        self.events.clear()
        await self.call(api.update_channel, self.star.id, self.room.id, UpdateChannel(name="Тихая"), user="owner")
        self.assertEqual(self.voice_events(), {})

    async def test_cabinet_owner_sees_their_cabinet(self):
        cabinet = await self.call(
            api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Кабинет Боба", room_kind="meeting", access="personal",
                          cabinet_owner_id=self.uid("bob"), hide_people=True),
            user="owner",
        )
        voice._add(self.star.id, cabinet.id, self.uid("alice"))
        bob = await self.call(api.get_star, self.star.id, user="bob")
        bob_view = [p.user_id for p in bob.voice[cabinet.id]]
        self.assertEqual(bob_view, [self.uid("alice")])

    async def test_setting_is_ignored_outside_work_stars(self):
        game = await self.make_star("gaming", name="Игра")
        planet = await self.call(
            api.create_channel, game.id, CreateChannel(kind="planet", name="Рейд", access="invite", hide_people=True), user="owner"
        )
        self.assertFalse(planet.hide_people)

"""Игровые Звёзды: правила и приветствие, фильтр слов, медленный режим, тайм-аут, свои роли,
журнал, опросы, сбор группы, временные Планеты, стикеры/эмодзи/звуки, звуковая панель.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import io
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from fastapi import UploadFile
from pydantic import ValidationError
from sqlalchemy import select

from app.api import star_community as community
from app.api import star_play as play
from app.api import stars as api
from app.core import voice
from app.core.config import settings
from app.models.star import StarChannel
from app.schemas.star import CreateChannel, SendStarMessage, SetStarReaction, UpdateChannel
from tests.stars_base import StarsTestBase

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
WAV = b"RIFF\x24\0\0\0WAVEfmt " + b"\0" * 64


def upload(data: bytes, name: str = "f") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name)


class StarGamingTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pushes: list[tuple[str, dict]] = []

        async def push(user_id, payload):
            self.pushes.append((user_id, payload))
            return 1

        async def apply_permissions(*_args):
            return None

        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, True)
        for patcher in (
            mock.patch.object(play, "send_push_to_user", push),
            mock.patch.object(voice, "_apply_permissions", apply_permissions),
            mock.patch.object(settings, "MEDIA_ROOT", self.media),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        play._last_sound.clear()
        self.star = await self.star_with_roles()
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")
        self.planet = next(c for c in self.star.channels if c.kind == "planet")

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def say(self, text: str, user: str = "alice"):
        return await self.call(api.send_message, self.star.id, self.sat.id, SendStarMessage(text=text), user=user)

    def events_of(self, kind: str) -> list[tuple[str, dict]]:
        return [(uid, e) for uid, e in self.events if e["type"] == kind]

    async def detail(self, user: str):
        return await self.call(api.get_star, self.star.id, user=user)

    # --- Правила и приветствие ---

    async def test_rules_must_be_accepted_before_posting(self):
        await self.call(
            community.update_community, self.star.id, community.CommunitySettings(rules_text="Не спамить"), user="owner"
        )
        self.assertFalse((await self.detail("alice")).rules_accepted)
        await self.expect_error(403, api.send_message, self.star.id, self.sat.id, SendStarMessage(text="привет"), user="alice")
        await self.say("я модератор", user="mod")  # модераторам правила не мешают

        await self.call(community.accept_rules, self.star.id, user="alice")
        await self.say("привет")
        # Правила поменялись — согласиться заново.
        await self.call(
            community.update_community, self.star.id, community.CommunitySettings(rules_text="Новые правила"), user="admin"
        )
        await self.expect_error(403, api.send_message, self.star.id, self.sat.id, SendStarMessage(text="x"), user="alice")
        await self.expect_error(
            403, community.update_community, self.star.id, community.CommunitySettings(rules_text="x"), user="mod"
        )

    async def test_newcomer_is_greeted_in_chosen_satellite(self):
        await self.call(
            community.update_community,
            self.star.id,
            community.CommunitySettings(welcome_channel_id=self.sat.id, welcome_text="Привет, {name}! Загляни в правила"),
            user="owner",
        )
        self.events.clear()
        await self.join(self.star.id, "carol")
        greeting = [e for _, e in self.events_of("star_message")][0]["message"]
        self.assertEqual((greeting["kind"], greeting["text"]), ("system", "Привет, carol! Загляни в правила"))

    # --- Фильтр слов ---

    async def test_banned_words_block_messages_except_for_admins(self):
        await self.call(
            community.update_community, self.star.id, community.CommunitySettings(banned_words=["Дурак", "дурак", " "]), user="owner"
        )
        self.assertEqual((await self.detail("owner")).banned_words, ["дурак"])
        self.assertEqual((await self.detail("alice")).banned_words, [])
        await self.expect_error(422, api.send_message, self.star.id, self.sat.id, SendStarMessage(text="сам ДУРАК"), user="alice")
        await self.say("дураки не прошли — другое слово")
        await self.say("сам дурак", user="admin")

    # --- Медленный режим ---

    async def test_slow_mode_spaces_messages_but_not_for_staff(self):
        with self.assertRaises(ValidationError):
            UpdateChannel(slow_mode_sec=7)
        await self.call(api.update_channel, self.star.id, self.sat.id, UpdateChannel(slow_mode_sec=30), user="owner")
        await self.say("раз")
        error = await self.expect_error(
            429, api.send_message, self.star.id, self.sat.id, SendStarMessage(text="два"), user="alice"
        )
        self.assertIn("через", error.detail)
        await self.say("раз", user="mod")
        await self.say("два", user="mod")

    # --- Тайм-аут ---

    async def test_timeout_silences_member_everywhere(self):
        msg = await self.say("до тайм-аута")
        voice._add(self.star.id, self.planet.id, self.uid("alice"))
        await self.expect_error(
            403, community.timeout_member, self.star.id, self.uid("mod"), community.TimeoutBody(minutes=5), user="alice"
        )
        self.events.clear()
        await self.call(community.timeout_member, self.star.id, self.uid("alice"), community.TimeoutBody(minutes=60), user="mod")
        member = [e["member"] for _, e in self.events_of("star_member_upsert")][0]
        self.assertIsNotNone(member["timeout_until"])
        self.assertTrue(voice.participants(self.planet.id)[0].server_muted)

        await self.expect_error(403, api.send_message, self.star.id, self.sat.id, SendStarMessage(text="x"), user="alice")
        await self.expect_error(
            403, api.set_reaction, self.star.id, self.sat.id, msg.id, SetStarReaction(emoji="👍"), user="alice"
        )
        await self.call(community.timeout_member, self.star.id, self.uid("alice"), community.TimeoutBody(minutes=None), user="mod")
        self.assertFalse(voice.participants(self.planet.id)[0].server_muted)
        await self.say("снова могу")
        with self.assertRaises(ValidationError):
            community.TimeoutBody(minutes=7)

    # --- Свои роли ---

    async def test_custom_roles_given_by_admins_or_chosen_by_self(self):
        tank = await self.call(
            community.create_tag, self.star.id, community.TagBody(name="Танк", color="#FF0000", self_assign=True), user="owner"
        )
        veteran = await self.call(
            community.create_tag, self.star.id, community.TagBody(name="Ветеран", color="#00ff00"), user="admin"
        )
        self.assertEqual(tank.color, "#ff0000")
        await self.expect_error(403, community.create_tag, self.star.id, community.TagBody(name="x", color="#000000"), user="mod")
        with self.assertRaises(ValidationError):
            community.TagBody(name="x", color="red")

        await self.call(community.give_tag, self.star.id, self.uid("alice"), tank.id, user="alice")
        await self.expect_error(403, community.give_tag, self.star.id, self.uid("alice"), veteran.id, user="alice")
        await self.expect_error(403, community.give_tag, self.star.id, self.uid("bob"), tank.id, user="alice")
        await self.call(community.give_tag, self.star.id, self.uid("alice"), veteran.id, user="admin")

        detail = await self.detail("bob")
        self.assertEqual([t.name for t in detail.tags], ["Танк", "Ветеран"])
        alice = next(m for m in detail.members if m.user.id == self.uid("alice"))
        self.assertEqual(sorted(alice.tag_ids), sorted([tank.id, veteran.id]))

        await self.call(community.take_tag, self.star.id, self.uid("alice"), tank.id, user="alice")
        await self.call(community.delete_tag, self.star.id, veteran.id, user="owner")
        alice = next(m for m in (await self.detail("bob")).members if m.user.id == self.uid("alice"))
        self.assertEqual(alice.tag_ids, [])

    # --- Журнал ---

    async def test_audit_log_records_moderation(self):
        await self.call(community.timeout_member, self.star.id, self.uid("bob"), community.TimeoutBody(minutes=5), user="mod")
        await self.call(api.kick_member, self.star.id, self.uid("bob"), user="admin")
        msg = await self.say("удалят")
        await self.call(api.delete_message, self.star.id, self.sat.id, msg.id, user="mod")
        log = await self.call(community.list_audit, self.star.id, user="owner", limit=50, before=None)
        self.assertEqual([e.action for e in log][:3], ["message_delete", "kick", "timeout"])
        self.assertEqual(log[1].target.username, "bob")
        self.assertEqual(log[0].details["text"], "удалят")
        await self.expect_error(403, community.list_audit, self.star.id, user="mod", limit=50, before=None)

    # --- Опросы ---

    async def test_poll_voting_and_closing(self):
        with self.assertRaises(ValidationError):
            play.PollBody(question="?", options=["да", "Да"])
        await self.call(
            play.create_poll, self.star.id, self.sat.id,
            play.PollBody(question="Какую карту?", options=["Dust", "Mirage", "Inferno"]), user="alice",
        )
        message = (await self.call(api.list_messages, self.star.id, self.sat.id, user="bob", limit=50, before_id=None))[-1]
        poll = message.poll
        self.assertEqual((message.kind, poll.question, len(poll.options)), ("poll", "Какую карту?", 3))

        await self.expect_error(422, play.vote, self.star.id, poll.id, play.VoteBody(options=[0, 1]), user="bob")
        await self.call(play.vote, self.star.id, poll.id, play.VoteBody(options=[0]), user="bob")
        out = await self.call(play.vote, self.star.id, poll.id, play.VoteBody(options=[1]), user="bob")
        self.assertEqual((out.my_votes, [o.votes for o in out.options]), ([1], [0, 1, 0]))
        self.assertEqual(out.options[1].voters, [self.uid("bob")])
        self.assertTrue(self.events_of("star_poll"))

        message = (await self.call(api.list_messages, self.star.id, self.sat.id, user="bob", limit=50, before_id=None))[-1]
        self.assertEqual(message.poll.my_votes, [1])
        message = (await self.call(api.list_messages, self.star.id, self.sat.id, user="alice", limit=50, before_id=None))[-1]
        self.assertEqual(message.poll.my_votes, [])

        await self.expect_error(403, play.close_poll, self.star.id, poll.id, user="bob")
        await self.call(play.close_poll, self.star.id, poll.id, user="alice")
        await self.expect_error(409, play.vote, self.star.id, poll.id, play.VoteBody(options=[2]), user="bob")

    async def test_anonymous_multiple_choice_poll_hides_voters(self):
        await self.call(
            play.create_poll, self.star.id, self.sat.id,
            play.PollBody(question="Когда играем?", options=["Пт", "Сб", "Вс"], multiple=True, anonymous=True), user="alice",
        )
        poll = (await self.call(api.list_messages, self.star.id, self.sat.id, user="bob", limit=50, before_id=None))[-1].poll
        out = await self.call(play.vote, self.star.id, poll.id, play.VoteBody(options=[0, 2]), user="bob")
        self.assertEqual(([o.votes for o in out.options], out.options[0].voters, out.total_voters), ([1, 0, 1], [], 1))

    # --- Сбор группы и временные Планеты ---

    async def test_lfg_fills_up_and_starts_a_temporary_planet(self):
        await self.call(
            play.create_lfg, self.star.id, self.sat.id, play.LfgBody(title="Dota, рейтинг", slots=2), user="alice"
        )
        lfg = (await self.call(api.list_messages, self.star.id, self.sat.id, user="bob", limit=50, before_id=None))[-1].lfg
        self.assertEqual((lfg.members, lfg.status), ([self.uid("alice")], "open"))
        await self.call(play.join_lfg, self.star.id, lfg.id, user="bob")
        await self.expect_error(409, play.join_lfg, self.star.id, lfg.id, user="mod")
        await self.expect_error(403, play.start_lfg_now, self.star.id, lfg.id, user="bob")

        self.events.clear()
        out = await self.call(play.start_lfg_now, self.star.id, lfg.id, user="alice")
        self.assertEqual(out.status, "started")
        async with self.Session() as db:
            planet = await db.get(StarChannel, out.planet_id)
        self.assertEqual((planet.temporary, planet.capacity, planet.name), (True, 2, "🎮 Dota, рейтинг"))
        notified = {uid for uid, _ in self.events_of("star_lfg_start")}
        self.assertEqual(notified, {self.uid("alice"), self.uid("bob")})
        self.assertEqual({uid for uid, _ in self.pushes}, notified)

    async def test_lfg_starts_by_itself_on_time(self):
        starts = datetime.now(timezone.utc) + timedelta(hours=1)
        await self.call(
            play.create_lfg, self.star.id, self.sat.id, play.LfgBody(title="Вечерний рейд", slots=5, starts_at=starts), user="bob"
        )
        async with self.Session() as db:
            self.assertEqual(await play.start_due_lfg(db), 0)
            self.assertEqual(await play.start_due_lfg(db, starts + timedelta(seconds=1)), 1)
        lfg = (await self.call(api.list_messages, self.star.id, self.sat.id, user="bob", limit=50, before_id=None))[-1].lfg
        self.assertEqual(lfg.status, "started")

    async def test_temporary_planets_do_not_count_and_vanish_when_empty(self):
        for i in range(4):  # у Звезды уже есть одна Планета — до лимита 5
            await self.call(api.create_channel, self.star.id, CreateChannel(kind="planet", name=f"p{i}"), user="owner")
        busy = await self.call(play.new_temporary_planet, self.star.id, play.TempPlanetBody(), user="alice")
        empty = await self.call(play.new_temporary_planet, self.star.id, play.TempPlanetBody(name="Катка"), user="bob")
        self.assertEqual((busy.name, busy.temporary), ("Планета alice", True))
        voice._add(self.star.id, busy.id, self.uid("alice"))

        later = datetime.now(timezone.utc) + timedelta(minutes=5)
        async with self.Session() as db:
            self.assertEqual(await play.sweep_temporary_planets(db), 0)  # только что созданы
            self.assertEqual(await play.sweep_temporary_planets(db, later), 1)
            remaining = (await db.execute(select(StarChannel.id).where(StarChannel.temporary.is_(True)))).scalars().all()
        self.assertEqual(remaining, [busy.id])
        self.assertIn(empty.id, [e["channel_id"] for _, e in self.events_of("star_channel_deleted")])

        with mock.patch.object(play.rules, "MAX_TEMP_PLANETS", 1):
            await self.expect_error(409, play.new_temporary_planet, self.star.id, play.TempPlanetBody(), user="mod")

    # --- Стикеры, эмодзи, звуки, звуковая панель ---

    async def test_assets_upload_rules(self):
        sticker = await self.call(
            play.upload_asset, self.star.id, kind="sticker", name="ГГ", file=upload(PNG), user="owner"
        )
        self.assertTrue(sticker.url.startswith(f"/media/stars/{self.star.id}/"))
        path = os.path.join(self.media, "stars", self.star.id, os.path.basename(sticker.url))
        self.assertTrue(os.path.exists(path))

        await self.call(play.upload_asset, self.star.id, kind="emoji", name="PogChamp", file=upload(PNG), user="owner")
        await self.expect_error(409, play.upload_asset, self.star.id, kind="emoji", name="pogchamp", file=upload(PNG), user="owner")
        await self.expect_error(422, play.upload_asset, self.star.id, kind="emoji", name="с пробелом", file=upload(PNG), user="owner")
        await self.expect_error(422, play.upload_asset, self.star.id, kind="sound", name="бум", file=upload(PNG), user="owner")
        await self.expect_error(403, play.upload_asset, self.star.id, kind="sticker", name="x", file=upload(PNG), user="alice")
        await self.call(play.upload_asset, self.star.id, kind="sound", name="Бум", emoji="💥", file=upload(WAV), user="owner")

        assets = await self.call(play.list_assets, self.star.id, user="bob")
        self.assertEqual([a.kind for a in assets], ["sticker", "emoji", "sound"])
        self.assertEqual(assets[1].name, "pogchamp")
        await self.call(play.delete_asset, self.star.id, sticker.id, user="owner")
        self.assertFalse(os.path.exists(path))

    async def test_soundboard_plays_for_planet_listeners_only(self):
        voice._add(self.star.id, self.planet.id, self.uid("alice"))
        voice._add(self.star.id, self.planet.id, self.uid("bob"))
        body = play.PlaySoundBody(sound="builtin:tada")
        await self.expect_error(409, play.play_sound, self.star.id, self.planet.id, body, user="mod")

        self.events.clear()
        await self.call(play.play_sound, self.star.id, self.planet.id, body, user="alice")
        heard = {uid for uid, e in self.events_of("star_sound")}
        self.assertEqual(heard, {self.uid("alice"), self.uid("bob")})
        self.assertEqual(self.events_of("star_sound")[0][1]["url"], "/sounds/board/tada.wav")
        await self.expect_error(429, play.play_sound, self.star.id, self.planet.id, body, user="alice")
        await self.expect_error(
            404, play.play_sound, self.star.id, self.planet.id, play.PlaySoundBody(sound="builtin:nope"), user="bob"
        )

        await self.call(
            community.update_community, self.star.id, community.CommunitySettings(soundboard=False), user="owner"
        )
        await self.expect_error(403, play.play_sound, self.star.id, self.planet.id, body, user="bob")


if __name__ == "__main__":
    unittest.main()

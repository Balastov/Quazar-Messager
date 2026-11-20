"""Чат комнаты: читают и пишут те, кто может войти; события, push, поиск и файлы — только им."""

import tempfile
from unittest import mock

from app.api import doors as doors_api
from app.api import guests
from app.api import notify as notify_api
from app.api import search as search_api
from app.api import star_files as files_api
from app.api import star_play as play
from app.api import star_work
from app.api import stars as api
from app.api import voice as voice_api
from app.core import doors, livekit, notify, voice
from app.core.config import settings
from app.schemas.star import CreateChannel, SendStarMessage, UpdateChannel
from tests.stars_base import StarsTestBase
from tests.voice_fakes import FakeRoomService, configure_livekit


class FakeRequest:
    def __init__(self, body: bytes):
        self.body = body
        self.headers = {"content-type": "text/plain", "content-length": str(len(body))}

    async def stream(self):
        yield self.body


class RoomChatTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        patcher = mock.patch.object(livekit, "room_service", self.lk)
        patcher.start()
        self.addCleanup(patcher.stop)
        doors.reset()
        self.addCleanup(doors.reset)
        media = tempfile.mkdtemp()
        for name, value in (("MEDIA_ROOT", media), ("MEDIA_MIN_FREE_MB", 0)):
            patcher = mock.patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.pushes: list[tuple[list[str], dict]] = []
        patcher = mock.patch.object(notify, "push_later", lambda ids, payload: self.pushes.append((ids, payload)))
        patcher.start()
        self.addCleanup(patcher.stop)

        self.star = await self.star_with_roles("work")
        self.open = next(c for c in self.star.channels if c.kind == "planet" and c.room_kind != "meeting")
        meeting = next(c for c in self.star.channels if c.room_kind == "meeting")
        self.closed = await self.call(
            api.update_channel, self.star.id, meeting.id, UpdateChannel(access="invite"), user="owner"
        )

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def say(self, channel_id: str, text: str, user: str):
        return await self.call(api.send_message, self.star.id, channel_id, SendStarMessage(text=text), user=user)

    async def feed(self, channel_id: str, user: str) -> list[str]:
        rows = await self.call(api.list_messages, self.star.id, channel_id, user=user, limit=50, before_id=None)
        return [m.text for m in rows]

    async def enter(self, user: str, channel_id: str):
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

    def got_message(self, user: str, text: str) -> bool:
        return any(
            uid == self.uid(user) and e["type"] == "star_message" and e["message"]["text"] == text
            for uid, e in self.events
        )

    # --- Открытая комната ---

    async def test_open_room_has_a_persistent_chat_for_everyone(self):
        await self.say(self.open.id, "Всем привет", user="alice")
        for name in ("owner", "bob", "mod"):
            self.assertTrue(self.got_message(name, "Всем привет"))
        # История остаётся — в комнате можно и не быть.
        self.assertEqual(await self.feed(self.open.id, "bob"), ["Всем привет"])
        await self.expect_error(404, api.list_messages, self.star.id, self.open.id, user="carol", limit=50, before_id=None)

    async def test_lobby_has_no_chat(self):
        async with self.Session() as db:
            lobby = await doors_api.ensure_lobby(db, await db.get(api.Star, self.star.id))
            await db.commit()
        await self.expect_error(400, api.send_message, self.star.id, lobby.id, SendStarMessage(text="x"), user="alice")

    # --- Закрытая комната ---

    async def test_closed_room_chat_is_for_those_who_may_enter(self):
        # Модератор впускает по стуку — чат ему открыт; обычному участнику — нет.
        await self.say(self.closed.id, "Повестка", user="mod")
        await self.expect_error(403, api.list_messages, self.star.id, self.closed.id, user="bob", limit=50, before_id=None)
        await self.expect_error(403, api.send_message, self.star.id, self.closed.id, SendStarMessage(text="x"), user="bob")
        self.assertTrue(self.got_message("owner", "Повестка"))
        self.assertFalse(self.got_message("bob", "Повестка"))
        self.assertFalse(self.got_message("alice", "Повестка"))

        # Вошёл (комната была пуста) — пока внутри, читает историю и получает новое.
        await self.enter("alice", self.closed.id)
        self.assertEqual(await self.feed(self.closed.id, "alice"), ["Повестка"])
        self.events.clear()
        await self.say(self.closed.id, "Начинаем", user="mod")
        self.assertTrue(self.got_message("alice", "Начинаем"))
        self.assertFalse(self.got_message("bob", "Начинаем"))

        # Вышел — доступ закрылся.
        await self.leave("alice", self.closed.id)
        await self.expect_error(403, api.list_messages, self.star.id, self.closed.id, user="alice", limit=50, before_id=None)

    async def test_personal_cabinet_chat(self):
        cabinet = await self.call(
            api.create_channel, self.star.id,
            CreateChannel(kind="planet", name="Кабинет Боба", access="personal", cabinet_owner_id=self.uid("bob")),
            user="owner",
        )
        await self.say(cabinet.id, "Заходите после обеда", user="bob")
        self.assertEqual(await self.feed(cabinet.id, "admin"), ["Заходите после обеда"])
        await self.expect_error(403, api.list_messages, self.star.id, cabinet.id, user="alice", limit=50, before_id=None)

    async def test_visitor_by_guest_link_talks_only_in_their_room(self):
        link = await self.call(
            guests.create_guest_link, self.star.id, self.closed.id, guests.CreateGuestLink(hours=2), user="owner"
        )
        await self.call(guests.claim_guest_link, link.code, user="carol")
        await self.say(self.closed.id, "Здравствуйте", user="carol")
        self.assertTrue(self.got_message("owner", "Здравствуйте"))
        await self.say(self.closed.id, "Добро пожаловать", user="owner")
        self.assertTrue(self.got_message("carol", "Добро пожаловать"))
        self.assertEqual(await self.feed(self.closed.id, "carol"), ["Здравствуйте", "Добро пожаловать"])
        await self.expect_error(403, api.list_messages, self.star.id, self.open.id, user="carol", limit=50, before_id=None)
        sat = next(c for c in self.star.channels if c.kind == "satellite")
        await self.expect_error(404, api.list_messages, self.star.id, sat.id, user="carol", limit=50, before_id=None)

    async def test_threads_reactions_and_deletion_follow_room_access(self):
        root = await self.say(self.closed.id, "Корень", user="mod")
        await self.expect_error(403, star_work.thread_messages, self.star.id, self.closed.id, root.id, user="bob")
        await self.expect_error(
            403, api.set_reaction, self.star.id, self.closed.id, root.id, api.SetStarReaction(emoji="👍"), user="bob"
        )
        await self.expect_error(403, api.delete_message, self.star.id, self.closed.id, root.id, user="bob")
        await self.call(api.set_reaction, self.star.id, self.closed.id, root.id, api.SetStarReaction(emoji="👍"), user="admin")

    # --- Опросы и сборы ---

    def got_event(self, user: str, kind: str) -> bool:
        return any(uid == self.uid(user) and e["type"] == kind for uid, e in self.events)

    async def test_polls_in_room_chat_follow_room_access(self):
        body = play.PollBody(question="Когда созвон?", options=["Утром", "Вечером"])
        await self.expect_error(403, play.create_poll, self.star.id, self.closed.id, body, user="bob")
        poll = await self.call(play.create_poll, self.star.id, self.closed.id, body, user="mod")
        self.assertEqual(await self.feed(self.closed.id, "mod"), ["Когда созвон?"])
        self.assertTrue(self.got_message("owner", "Когда созвон?"))
        self.assertFalse(self.got_message("bob", "Когда созвон?"))

        # Голосуют те, кто может войти; остальным опрос не виден — и голоса тоже.
        await self.expect_error(403, play.vote, self.star.id, poll["id"], play.VoteBody(options=[0]), user="bob")
        self.events.clear()
        out = await self.call(play.vote, self.star.id, poll["id"], play.VoteBody(options=[1]), user="admin")
        self.assertEqual(out.my_votes, [1])
        self.assertTrue(self.got_event("owner", "star_poll"))
        self.assertFalse(self.got_event("bob", "star_poll"))
        self.assertFalse(self.got_event("alice", "star_poll"))

        # Гость по ссылке в эту комнату тоже голосует.
        link = await self.call(
            guests.create_guest_link, self.star.id, self.closed.id, guests.CreateGuestLink(hours=2), user="owner"
        )
        await self.call(guests.claim_guest_link, link.code, user="carol")
        out = await self.call(play.vote, self.star.id, poll["id"], play.VoteBody(options=[0]), user="carol")
        self.assertEqual(out.total_voters, 2)
        await self.expect_error(403, play.close_poll, self.star.id, poll["id"], user="bob")
        await self.call(play.close_poll, self.star.id, poll["id"], user="mod")

    async def test_gatherings_in_room_chat(self):
        made = await self.call(
            play.create_lfg, self.star.id, self.open.id, play.LfgBody(title="Ретро", slots=4), user="alice"
        )
        async with self.Session() as db:
            lfg = await db.get(play.StarLfg, made["id"])
            # Сбор из чата комнаты — на этаже этой комнаты.
            self.assertEqual(lfg.floor_id, self.open.floor_id)
        self.assertEqual(await self.feed(self.open.id, "bob"), ["Ретро"])
        await self.call(play.join_lfg, self.star.id, made["id"], user="bob")

        # В закрытой комнате записаться может только тот, кто видит её чат.
        closed = await self.call(
            play.create_lfg, self.star.id, self.closed.id, play.LfgBody(title="Разбор", slots=4), user="mod"
        )
        await self.expect_error(403, play.join_lfg, self.star.id, closed["id"], user="bob")
        await self.expect_error(403, play.cancel_lfg, self.star.id, closed["id"], user="bob")

        # Посетитель по гостевой ссылке читает чат, но сборы — для участников Звезды.
        link = await self.call(
            guests.create_guest_link, self.star.id, self.closed.id, guests.CreateGuestLink(hours=2), user="owner"
        )
        await self.call(guests.claim_guest_link, link.code, user="carol")
        await self.expect_error(403, play.join_lfg, self.star.id, closed["id"], user="carol")
        await self.expect_error(
            403, play.create_lfg, self.star.id, self.closed.id, play.LfgBody(title="Х", slots=2), user="carol"
        )

    # --- Поиск и файлы ---

    async def test_search_and_files_hide_closed_room_chats(self):
        await self.say(self.closed.id, "секретный план", user="mod")
        await self.say(self.open.id, "открытый план", user="alice")
        found = lambda user: self.call(  # noqa: E731
            search_api.search_messages, self.star.id, user=user, q="план", channel_id=None, before=None, limit=30
        )
        self.assertEqual({m.text for m in await found("bob")}, {"открытый план"})
        self.assertEqual({m.text for m in await found("owner")}, {"открытый план", "секретный план"})

        uploaded = await self.call(
            files_api.upload_file, self.star.id, self.closed.id, FakeRequest(b"data"), user="mod", name="план.txt"
        )
        await self.call(api.send_message, self.star.id, self.closed.id,
                        SendStarMessage(text="", file_id=uploaded.id), user="mod")
        listed = lambda user: self.call(  # noqa: E731
            files_api.list_files, self.star.id, user=user, q="", channel_id=None, kind="all", before=None, limit=50
        )
        self.assertEqual([f.id for f in (await listed("owner")).files], [uploaded.id])
        self.assertEqual((await listed("bob")).files, [])
        await self.expect_error(404, files_api.download_file, self.star.id, uploaded.id, user="bob")
        await self.call(files_api.download_file, self.star.id, uploaded.id, user="admin")

    # --- Уведомления ---

    def pushed(self, user: str) -> bool:
        return any(self.uid(user) in ids for ids, _ in self.pushes)

    async def test_room_chat_notifies_mentions_and_replies_by_default(self):
        await self.say(self.open.id, "просто так", user="alice")
        self.assertFalse(self.pushed("bob"))
        await self.say(self.open.id, "@bob загляни", user="alice")
        self.assertTrue(self.pushed("bob"))

        # Своя настройка чата комнаты сильнее умолчания.
        self.pushes.clear()
        await self.call(notify_api.set_notify, "channel", self.open.id, notify_api.NotifyBody(level="all"), user="mod")
        await self.say(self.open.id, "ещё", user="alice")
        self.assertTrue(self.pushed("mod"))
        self.assertFalse(self.pushed("bob"))

    async def test_room_chat_push_reaches_only_those_who_may_enter(self):
        await self.say(self.closed.id, "@bob @admin сюда", user="mod")
        self.assertTrue(self.pushed("admin"))
        self.assertFalse(self.pushed("bob"))

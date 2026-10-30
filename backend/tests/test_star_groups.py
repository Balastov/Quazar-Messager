"""Группы (роль с именем для упоминания), @here и @channel в Спутниках.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import unittest
from unittest import mock

from pydantic import ValidationError

from app.api import star_community as community
from app.api import stars as api
from app.core import notify, presence
from app.schemas.star import SendStarMessage
from tests.stars_base import StarsTestBase


class FindMentionsTest(unittest.TestCase):
    def test_groups_here_and_channel(self):
        names = {"alice": "a", "bob": "b"}
        groups = {"backend": ["a", "c"], "design": ["d"]}
        found = notify.find_mentions("@Backend и @bob, @design.", names, groups)
        self.assertEqual(found.ids, {"a", "b", "c", "d"})
        self.assertFalse(found.everyone or found.here)
        self.assertTrue(notify.find_mentions("@channel сбор", names).everyone)
        self.assertTrue(notify.find_mentions("@канал сбор", names).everyone)
        here = notify.find_mentions("@here кто тут? и @тут", names)
        self.assertTrue(here.here)
        self.assertFalse(here.everyone)

    def test_username_wins_over_group(self):
        found = notify.find_mentions("@alice", {"alice": "a"}, {"alice": ["x", "y"]})
        self.assertEqual(found.ids, {"a"})

    def test_group_in_code_is_not_a_mention(self):
        self.assertEqual(notify.find_mentions("`@backend`", {}, {"backend": ["a"]}).ids, set())


class StarGroupsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pushes: list[tuple[list[str], dict]] = []
        patcher = mock.patch.object(notify, "push_later", lambda ids, payload: self.pushes.append((ids, payload)))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")
        presence._announced.clear()
        self.addCleanup(presence._announced.clear)

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def say(self, text: str, user="alice"):
        return await self.call(api.send_message, self.star.id, self.sat.id, SendStarMessage(text=text), user=user)

    async def group(self, handle: str | None, *members: str, name="Бэкенд"):
        tag = await self.call(
            community.create_tag, self.star.id, community.TagBody(name=name, color="#22aa88", handle=handle), user="owner"
        )
        for m in members:
            await self.call(community.give_tag, self.star.id, self.uid(m), tag.id, user="owner")
        return tag

    async def test_group_mention_reaches_holders(self):
        tag = await self.group("backend", "bob", "admin", "alice")
        self.assertEqual(tag.handle, "backend")
        msg = await self.say("@Backend посмотрите релиз")
        # Автора (alice) не упоминаем, даже если он в группе.
        self.assertEqual(set(msg.mentions), {self.uid("bob"), self.uid("admin")})
        self.assertFalse(msg.mention_all)
        self.assertEqual(set(self.pushes[-1][0]), {self.uid("bob"), self.uid("admin")})

    async def test_role_without_handle_is_not_mentionable(self):
        await self.group(None, "bob", name="Танк")
        self.assertEqual((await self.say("@Танк сюда")).mentions, [])

    async def test_handle_rules(self):
        await self.group("backend", "bob")
        err = await self.expect_error(
            409, community.create_tag, self.star.id, community.TagBody(name="Другая", color="#000000", handle="BACKEND"),
            user="owner",
        )
        self.assertIn("другой роли", err.detail)
        err = await self.expect_error(
            409, community.create_tag, self.star.id, community.TagBody(name="Ник", color="#000000", handle="Bob"),
            user="owner",
        )
        self.assertIn("ник участника", err.detail)
        for bad in ("here", "все", "a", "с пробелом", "end."):
            with self.assertRaises(ValidationError, msg=bad):
                community.TagBody(name="x", color="#000000", handle=bad)
        self.assertEqual(community.TagBody(name="x", color="#000000", handle="@design").handle, "design")
        self.assertIsNone(community.TagBody(name="x", color="#000000", handle="  ").handle)

    async def test_update_keeps_handle_unless_sent(self):
        tag = await self.group("backend", "bob")
        # Старый клиент присылает только название, цвет и «можно себе».
        body = community.TagBody.model_validate({"name": "Бэк", "color": "#111111", "self_assign": True})
        out = await self.call(community.update_tag, self.star.id, tag.id, body, user="owner")
        self.assertEqual(out.handle, "backend")
        body = community.TagBody.model_validate({"name": "Бэк", "color": "#111111", "handle": ""})
        out = await self.call(community.update_tag, self.star.id, tag.id, body, user="owner")
        self.assertIsNone(out.handle)

    async def test_here_mentions_only_online_and_only_from_staff(self):
        presence._announced.update({self.uid("bob"): presence.ONLINE, self.uid("admin"): presence.AWAY})
        msg = await self.say("@here кто на месте?", user="mod")
        self.assertEqual(msg.mentions, [self.uid("bob")])
        self.assertFalse(msg.mention_all)
        self.assertEqual((await self.say("@here кто на месте?")).mentions, [])

    async def test_channel_is_everyone(self):
        self.assertTrue((await self.say("@channel планёрка", user="mod")).mention_all)
        self.assertFalse((await self.say("@channel планёрка")).mention_all)


if __name__ == "__main__":
    unittest.main()

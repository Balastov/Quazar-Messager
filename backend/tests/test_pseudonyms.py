"""Star aliases: Unicode, censorship, role protection and per-viewer presentation."""
import unittest
from unittest import mock

from pydantic import ValidationError

from app.api import search, star_notes, star_shares, stars
from app.core.pseudonyms import normalize_pseudonym
from app.models.user import User
from app.schemas.star import SendStarMessage, UpdateMemberPseudonym
from tests.stars_base import StarsTestBase


class PseudonymRulesTest(unittest.TestCase):
    def test_symbols_emoji_and_short_han_names(self):
        for name in ["Луна", "Night fox", "123", "!!!", "😊😊😊", "龍", "小明", "👨‍👩‍👧‍👦" * 3, "éab", "a" * 64]:
            with self.subTest(name=name):
                self.assertEqual(normalize_pseudonym(name), name)
        self.assertEqual(normalize_pseudonym("  Лу́на  "), "Лу́на")
        self.assertIsNone(normalize_pseudonym("   "))
        self.assertIsNone(normalize_pseudonym(None))

    def test_visible_symbol_count_not_codepoints(self):
        for name in ["A", "AB", "龍A", "😊😊", "👨‍👩‍👧‍👦", "🇷🇺🇨🇳", "a\u0301b", "\u200dAB", "a" * 65, "a\nb", "a\u2028bc", "abc\u202e", "\u0301\u0301\u0301"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                normalize_pseudonym(name)

    def test_account_name_censorship_also_applies_to_aliases(self):
        for name in ["хуй", "p1zda", "Администратор", "QuazarTeam", "с\u200dу\u200dк\u200dа"]:
            with self.subTest(name=name), self.assertRaises(ValidationError):
                UpdateMemberPseudonym(pseudonym=name)
        self.assertEqual(UpdateMemberPseudonym(pseudonym="Шебалин").pseudonym, "Шебалин")
        with self.assertRaises(ValidationError):
            UpdateMemberPseudonym()


class PseudonymApiTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles()
        self.satellite = next(channel for channel in self.star.channels if channel.kind == "satellite")
        async with self.Session() as db:
            person = await db.get(User, self.users["alice"].id)
            person.first_name, person.last_name = "Алиса", "Иванова"
            await db.commit()

    async def alias(self, person, value, actor=None, star_id=None):
        return await self.call(stars.update_member_pseudonym, star_id or self.star.id, self.users[person].id,
            UpdateMemberPseudonym(pseudonym=value), user=actor or person)

    async def test_own_alias_is_scoped_and_account_name_is_untouched(self):
        out = await self.alias("alice", "Луна")
        self.assertEqual(out.user.pseudonym, "Луна")
        self.assertEqual(out.user.display_name, "Луна")
        self.assertEqual(out.user.account_display_name, "Алиса Иванова")
        other = await self.make_star(user="carol")
        await self.join(other.id, "alice", inviter="carol")
        await self.alias("alice", "小明", star_id=other.id)
        for sid, expected in [(self.star.id, "Луна"), (other.id, "小明")]:
            detail = await self.call(stars.get_star, sid, user="alice")
            member = next(item for item in detail.members if item.user.id == self.users["alice"].id)
            self.assertEqual((member.user.pseudonym, member.user.pseudonym_star_id), (expected, sid))
        async with self.Session() as db:
            account = await db.get(User, self.users["alice"].id)
            self.assertEqual((account.display_name, account.username), ("Алиса Иванова", "alice"))
        await self.alias("alice", None)
        detail = await self.call(stars.get_star, self.star.id, user="bob")
        member = next(item for item in detail.members if item.user.id == self.users["alice"].id)
        self.assertIsNone(member.user.pseudonym)
        self.assertEqual(member.user.display_name, "Алиса Иванова")

    async def test_owner_and_admin_can_edit_only_non_administrators(self):
        for role in ["owner", "admin", "mod", "alice"]:
            await self.alias(role, "Орион")
        for actor, target in [("owner", "alice"), ("admin", "bob"), ("owner", "mod"), ("admin", "mod")]:
            self.assertEqual((await self.alias(target, "Луна", actor)).user.pseudonym, "Луна")
        for actor, target in [("alice", "bob"), ("mod", "alice"), ("owner", "admin"), ("admin", "owner")]:
            for value in ["Луна", None]:
                await self.expect_error(403, stars.update_member_pseudonym, self.star.id, self.users[target].id,
                    UpdateMemberPseudonym(pseudonym=value), user=actor)
        await self.expect_error(404, stars.update_member_pseudonym, self.star.id, self.users["alice"].id,
            UpdateMemberPseudonym(pseudonym="Луна"), user="carol")

    async def test_history_replies_and_events_use_current_alias(self):
        first = await self.call(stars.send_message, self.star.id, self.satellite.id, SendStarMessage(text="Первое сообщение"), user="alice")
        self.events.clear()
        await self.alias("alice", "Луна")
        events = [event for uid, event in self.events if uid == self.users["bob"].id and event["type"] == "star_member_upsert"]
        self.assertEqual(events[-1]["member"]["user"]["pseudonym"], "Луна")
        with mock.patch("app.core.notify.push_later") as push:
            reply = await self.call(stars.send_message, self.star.id, self.satellite.id,
                SendStarMessage(text="Второе сообщение", reply_to_id=first.id), user="alice")
            self.assertTrue(any(call.args[1]["title"].startswith("Луна ·") for call in push.call_args_list))
        self.assertEqual(reply.sender.pseudonym, "Луна")
        self.assertEqual(reply.reply_to.sender.pseudonym, "Луна")
        async with self.Session() as db:
            rows = await stars._messages_out(db, [(await db.get(stars.StarMessage, first.id), await db.get(User, self.users["alice"].id))], star_id=self.star.id)
        self.assertEqual((rows[0].sender.pseudonym, rows[0].text), ("Луна", "Первое сообщение"))

    async def test_alias_version_is_monotonic_and_repeated_values_are_noops(self):
        first = await self.alias("alice", "Луна")
        repeat = await self.alias("alice", "Луна")
        cleared = await self.alias("alice", None)
        self.assertEqual((first.user.pseudonym_version, repeat.user.pseudonym_version, cleared.user.pseudonym_version), (1, 1, 2))

    async def test_live_room_display_name_is_refreshed(self):
        with mock.patch("app.core.voice.channels_with_user", return_value=["planet"]), mock.patch("app.core.livekit.room_service.update_name") as update:
            await self.alias("alice", "Луна")
            update.assert_awaited_once_with("planet-planet", self.users["alice"].id, "Луна")


class SharedPseudonymsTest(StarsTestBase):
    async def test_shared_satellite_and_notes_resolve_names_in_the_viewing_star(self):
        home = await self.star_with_roles(kind="work")
        guest = await self.make_star(kind="work", user="carol")
        await self.join(guest.id, "bob", inviter="carol")
        channel = next(item for item in home.channels if item.kind == "satellite")
        invite = await self.call(star_shares.create_share_invite, home.id, channel.id, user="owner")
        await self.call(star_shares.accept_invite, invite.code, star_shares.AcceptBody(star_id=guest.id), user="carol")
        for sid, actor, value in [(home.id, "owner", "Сокол"), (guest.id, "carol", "Сова")]:
            await self.call(stars.update_member_pseudonym, sid, self.users["bob"].id, UpdateMemberPseudonym(pseudonym=value), user=actor)
        self.events.clear()
        sent = await self.call(stars.send_message, guest.id, channel.id, SendStarMessage(text="Общий спутник"), user="bob")
        self.assertEqual((sent.sender.pseudonym, sent.sender.pseudonym_star_id), ("Сова", guest.id))
        for name, expected in [("alice", "Сокол"), ("carol", "Сова")]:
            event = next(event for uid, event in self.events if uid == self.users[name].id and event["type"] == "star_message")
            self.assertEqual(event["message"]["sender"]["pseudonym"], expected)
        await self.call(star_notes.save_notes, guest.id, channel.id, star_notes.SaveNote(text="Заметки", base_version=0), user="bob")
        for sid, reader, expected in [(home.id, "alice", "Сокол"), (guest.id, "carol", "Сова")]:
            found = await self.call(search.search_messages, sid, user=reader, q="Общий", limit=30)
            self.assertEqual(found[0].sender.pseudonym, expected)
            note = await self.call(star_notes.get_notes, sid, channel.id, user=reader)
            self.assertEqual(note.updated_by.pseudonym, expected)

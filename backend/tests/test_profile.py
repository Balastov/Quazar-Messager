"""Профиль: никнейм латиницей (уникален без учёта регистра), почта, имя и фамилия."""

import unittest
import secrets
import io
import tempfile
from pathlib import Path
from unittest import mock
from datetime import datetime, timedelta, timezone
from app.models.phone_verification import PhoneVerification
from app.core.phone_verification import digest

from fastapi import HTTPException, UploadFile
from pydantic import ValidationError

from app.api import auth, users
from app.core.profile import normalize_email, normalize_person_name, normalize_username
from app.core.avatars import MAX_AVATAR_BYTES, save_avatar
from app.core.config import settings
from app.core.legacy_avatars import migrate_legacy_avatar_urls
from app.models.chat import Chat, ChatMember
from app.models.user import User
from app.schemas.user import MeOut, UpdateProfile, UserOut, UserRegister
from tests.stars_base import StarsTestBase


class TestProfileRules(unittest.TestCase):
    def test_username_latin_only(self):
        self.assertEqual(normalize_username("  @Alex_99.dev "), "Alex_99.dev")
        for bad in ("Алекс", "al", "9lives", "a b", "alex.", "al..ex", "x" * 33, "All", "Quazar"):
            with self.assertRaises(ValueError, msg=bad):
                normalize_username(bad)

    def test_email(self):
        self.assertEqual(normalize_email(" Alex@Mail.RU "), "alex@mail.ru")
        self.assertIsNone(normalize_email("   "))
        with self.assertRaises(ValueError):
            normalize_email("not-an-email")

    def test_person_name_any_language(self):
        self.assertEqual(normalize_person_name("  Алексей  "), "Алексей")
        self.assertEqual(normalize_person_name("Jean  Luc"), "Jean Luc")
        self.assertEqual(normalize_person_name("李"), "李")
        self.assertIsNone(normalize_person_name(""))
        for bad in ("123", "a​b", "x" * 65):
            with self.assertRaises(ValueError, msg=bad):
                normalize_person_name(bad)

    def test_register_requires_phone_and_username(self):
        with self.assertRaises(ValidationError):
            UserRegister(username="alex")  # type: ignore[call-arg]
        with self.assertRaises(ValidationError):
            UserRegister(phone="+79991234567")  # type: ignore[call-arg]
        body = UserRegister(
            username="alex", phone="89991234567", phone_discoverable=True, email=""
        )
        self.assertIsNone(body.email)

    def test_display_name(self):
        user = User(username="alex", first_name="Алексей", last_name=None)
        self.assertEqual(user.display_name, "Алексей")
        user.last_name = "Иванов"
        self.assertEqual(user.display_name, "Алексей Иванов")
        self.assertEqual(User(username="alex").display_name, "alex")


class TestProfileApi(StarsTestBase):
    async def call(self, fn, *args, user: str, **kwargs):
        # Как get_current_user: пользователь из той же сессии, что и запрос.
        async with self.Session() as db:
            current = await db.get(User, self.users[user].id)
            return await fn(*args, current_user=current, db=db, **kwargs)

    async def register(self, **fields):
        body = UserRegister(**{"phone_discoverable": True, **fields})
        async with self.Session() as db:
            token = secrets.token_urlsafe(32); stamp = datetime.now(timezone.utc)
            db.add(PhoneVerification(token_hash=digest(token), phone=body.phone, purpose="register", ip_hash="test", campaign_id="test",
                state="verified", created_at=stamp, verified_at=stamp, expires_at=stamp + timedelta(minutes=5)))
            await db.flush(); body.phone_verification_token = token
            return await auth.register(body, db=db)

    async def check(self, username: str):
        async with self.Session() as db:
            return await auth.username_available(username, db=db)

    async def test_register_with_optional_fields(self):
        await self.register(
            phone_discoverable=False,
            username="Neo", phone="+79991112233", email="Neo@Matrix.io", first_name="Томас", last_name="Андерсон"
        )
        async with self.Session() as db:
            user = (await db.execute(User.__table__.select().where(User.username == "Neo"))).first()
        self.assertEqual(user.email, "neo@matrix.io")
        self.assertEqual((user.first_name, user.last_name), ("Томас", "Андерсон"))

    async def test_username_unique_ignoring_case(self):
        self.assertFalse((await self.check("ALICE")).available)
        self.assertEqual((await self.check("ALICE")).reason, "Этот никнейм уже занят")
        self.assertFalse((await self.check("Алиса")).available)
        self.assertTrue((await self.check("@alice2")).available)
        with self.assertRaises(HTTPException) as ctx:
            await self.register(username="Alice", phone="+79991112233")
        self.assertIn("никнейм", ctx.exception.detail)

    async def test_phone_and_email_unique(self):
        await self.register(username="first", phone="+79991112233", email="a@b.ru")
        with self.assertRaises(HTTPException) as ctx:
            await self.register(username="second", phone="+79991112233")
        self.assertIn("номер", ctx.exception.detail)
        with self.assertRaises(HTTPException) as ctx:
            await self.register(username="second", phone="+79991112234", email="A@B.ru")
        self.assertIn("почта", ctx.exception.detail)

    async def test_update_profile(self):
        me = await self.call(
            users.update_me,
            UpdateProfile(username="Alice_W", email="alice@w.ru", first_name="Алиса", last_name="Чудесова"),
            user="alice",
        )
        out = MeOut.model_validate(me)
        self.assertEqual((out.username, out.email, out.display_name), ("Alice_W", "alice@w.ru", "Алиса Чудесова"))
        # Почта видна только самому пользователю.
        self.assertNotIn("email", UserOut.model_validate(me).model_dump())

        # Не присланные поля не трогаем, пустая строка — убрать.
        me = await self.call(users.update_me, UpdateProfile(last_name=""), user="alice")
        self.assertEqual((me.first_name, me.last_name, me.email), ("Алиса", None, "alice@w.ru"))

        # Свой же ник в другом регистре — можно, чужой — нет.
        await self.call(users.update_me, UpdateProfile(username="alice_w"), user="alice")
        await self.expect_error(400, users.update_me, UpdateProfile(username="BOB"), user="alice")
        await self.expect_error(400, users.update_me, UpdateProfile(email="ALICE@w.ru"), user="bob")
        await self.expect_error(422, users.update_me, UpdateProfile(username=None), user="alice")
        self.assertTrue(any(e["type"] == "user_updated" for _, e in self.events))

    async def test_search_by_name(self):
        await self.call(users.update_me, UpdateProfile(first_name="Василиса"), user="carol")
        async with self.Session() as db:
            found = await users.search_users("васил", current_user=self.users["bob"], db=db)
        self.assertEqual([u.username for u in found], ["carol"])


class TestHiddenPhone(StarsTestBase):
    async def call(self, fn, *args, user: str, **kwargs):
        async with self.Session() as db:
            current = await db.get(User, self.users[user].id)
            return await fn(*args, current_user=current, db=db, **kwargs)

    async def search(self, q: str, user: str = "bob"):
        async with self.Session() as db:
            return [u.username for u in await users.search_users(q, current_user=self.users[user], db=db)]

    def test_register_requires_choice(self):
        with self.assertRaises(ValidationError):
            UserRegister(username="alex", phone="+79991234567")  # type: ignore[call-arg]

    async def test_hidden_phone(self):
        carol = self.users["carol"].phone
        # Найти можно только по номеру целиком, не по кусочку.
        self.assertEqual(await self.search(carol), ["carol"])
        self.assertEqual(await self.search(carol[-4:]), [])

        me = await self.call(users.update_me, UpdateProfile(phone_discoverable=False), user="carol")
        self.assertEqual(await self.search(carol), [])
        self.assertEqual(await self.search("carol"), ["carol"])
        # Номер не видит никто, кроме самого пользователя.
        self.assertIsNone(UserOut.model_validate(me).phone)
        self.assertEqual(MeOut.model_validate(me).phone, carol)
        self.assertFalse(MeOut.model_validate(me).phone_discoverable)
        await self.expect_error(422, users.update_me, UpdateProfile(phone_discoverable=None), user="carol")

    async def test_unchosen_is_hidden(self):
        async with self.Session() as db:
            user = await db.get(User, self.users["carol"].id)
            user.phone_discoverable = None
            await db.commit()
        self.assertEqual(await self.search(self.users["carol"].phone), [])
        self.assertIsNone(MeOut.model_validate(user).phone_discoverable)
        self.assertIsNone(UserOut.model_validate(user).phone)


PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


class TestAvatarCache(unittest.TestCase):
    def test_replacement_with_same_format_and_timestamp_has_a_new_url(self):
        user_id = "01234567-89ab-cdef-0123-456789abcdef"
        with tempfile.TemporaryDirectory() as media, mock.patch.object(settings, "MEDIA_ROOT", media), mock.patch("app.core.avatars.time.time", return_value=123):
            first = save_avatar(user_id, PNG, ".png")
            second = save_avatar(user_id, PNG + b"new picture", ".png")
            self.assertNotEqual(first, second)
            self.assertRegex(second, rf"^/media/avatars/{user_id}\.png\?v=[0-9a-f]{{64}}$")
            self.assertEqual((Path(media) / "avatars" / f"{user_id}.png").read_bytes(), PNG + b"new picture")
            self.assertEqual(len(list((Path(media) / "avatars").iterdir())), 1)


class TestAvatarApi(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.media = Path(directory.name)
        patcher = mock.patch.object(settings, "MEDIA_ROOT", directory.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        async with self.Session() as db:
            alice = await db.get(User, self.users["alice"].id)
            alice.email = "private@example.test"
            alice.phone_discoverable = False
            chat = Chat(type="direct")
            db.add(chat)
            await db.flush()
            db.add_all([ChatMember(chat_id=chat.id, user_id=self.users[name].id) for name in ("alice", "bob")])
            await db.commit()
        self.events.clear()

    async def call_avatar(self, fn, data=None):
        async with self.Session() as db:
            current = await db.get(User, self.users["alice"].id)
            kwargs = {"file": UploadFile(file=io.BytesIO(data), filename="avatar.png")} if data is not None else {}
            return await fn(current_user=current, db=db, **kwargs)

    async def test_new_photo_reaches_own_devices_and_peer_without_private_fields(self):
        first = await self.call_avatar(users.upload_avatar, PNG)
        second = await self.call_avatar(users.upload_avatar, PNG + b"replacement")
        self.assertNotEqual(first.avatar_url, second.avatar_url)
        async with self.Session() as db:
            stored = await db.get(User, self.users["alice"].id)
            self.assertEqual(stored.avatar_url, second.avatar_url)
        own = [event["user"] for uid, event in self.events if uid == self.users["alice"].id][-1]
        peer = [event["user"] for uid, event in self.events if uid == self.users["bob"].id][-1]
        self.assertEqual(own["avatar_url"], second.avatar_url)
        self.assertEqual(peer["avatar_url"], second.avatar_url)
        self.assertEqual(own["phone"], self.users["alice"].phone)
        self.assertEqual(own["email"], "private@example.test")
        self.assertIsNone(peer["phone"])
        self.assertNotIn("email", peer)
        self.assertNotIn("phone_verified_at", peer)
        self.assertNotIn(self.users["carol"].id, [uid for uid, _ in self.events])

    async def test_removal_refreshes_own_devices_and_peer(self):
        await self.call_avatar(users.upload_avatar, PNG)
        self.events.clear()
        removed = await self.call_avatar(users.remove_avatar)
        self.assertIsNone(removed.avatar_url)
        self.assertEqual(list((self.media / "avatars").iterdir()), [])
        self.assertEqual({uid for uid, _ in self.events}, {self.users["alice"].id, self.users["bob"].id})
        self.assertTrue(all(event["user"]["avatar_url"] is None for _, event in self.events))

    async def test_rejected_upload_preserves_previous_photo(self):
        previous = (await self.call_avatar(users.upload_avatar, PNG)).avatar_url
        self.events.clear()
        for data, code in [(b"not an image", 422), (PNG + b"\0" * MAX_AVATAR_BYTES, 413)]:
            with self.assertRaises(HTTPException) as caught:
                await self.call_avatar(users.upload_avatar, data)
            self.assertEqual(caught.exception.status_code, code)
        async with self.Session() as db:
            self.assertEqual((await db.get(User, self.users["alice"].id)).avatar_url, previous)
        self.assertEqual((self.media / "avatars" / f"{self.users['alice'].id}.png").read_bytes(), PNG)
        self.assertEqual(self.events, [])

    async def test_legacy_urls_are_invalidated_only_once(self):
        legacy = f"/media/avatars/{self.users['alice'].id}.png"
        versioned = f"/media/avatars/{self.users['bob'].id}.jpg?v=existing"
        external = "https://example.test/avatar.png"
        async with self.Session() as db:
            for name, url in [("alice", legacy), ("bob", versioned), ("carol", external)]:
                (await db.get(User, self.users[name].id)).avatar_url = url
            await db.commit()
        for _ in range(2):
            async with self.engine.begin() as conn:
                await migrate_legacy_avatar_urls(conn)
        async with self.Session() as db:
            self.assertEqual((await db.get(User, self.users["alice"].id)).avatar_url, legacy + "?v=profile-cache-1")
            self.assertEqual((await db.get(User, self.users["bob"].id)).avatar_url, versioned)
            self.assertEqual((await db.get(User, self.users["carol"].id)).avatar_url, external)
            self.assertIsNone((await db.get(User, self.users["owner"].id)).avatar_url)


if __name__ == "__main__":
    unittest.main()

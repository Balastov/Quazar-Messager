"""Профиль: никнейм латиницей (уникален без учёта регистра), почта, имя и фамилия."""

import unittest

from fastapi import HTTPException
from pydantic import ValidationError

from app.api import auth, users
from app.core.profile import normalize_email, normalize_person_name, normalize_username
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
            UserRegister(username="alex", password="password1")  # type: ignore[call-arg]
        with self.assertRaises(ValidationError):
            UserRegister(phone="+79991234567", password="password1")  # type: ignore[call-arg]
        body = UserRegister(
            username="alex", phone="89991234567", password="password1", phone_discoverable=True, email=""
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
        body = UserRegister(**{"password": "password1", "phone_discoverable": True, **fields})
        async with self.Session() as db:
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
            UserRegister(username="alex", phone="+79991234567", password="password1")  # type: ignore[call-arg]

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


if __name__ == "__main__":
    unittest.main()

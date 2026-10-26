"""Старые ники не латиницей: транслитерация и перенос прежнего ника в «Имя»."""

import unittest

from sqlalchemy import select

from app.core.legacy_usernames import latin_nick, migrate_legacy_usernames, transliterate
from app.core.profile import normalize_username
from app.models.user import User
from tests.stars_base import StarsTestBase


class TestTransliterate(unittest.TestCase):
    def test_examples(self):
        self.assertEqual(transliterate("Бабан"), "Baban")
        self.assertEqual(transliterate("Жора"), "Zhora")
        self.assertEqual(transliterate("ЖОРА"), "ZHORA")
        self.assertEqual(transliterate("Щукин_Юрий"), "Shchukin_Yuriy")
        self.assertEqual(transliterate("Объект"), "Obekt")
        self.assertEqual(transliterate("Їжак"), "Yizhak")
        self.assertEqual(transliterate("José"), "Jose")

    def test_latin_nick_passes_rules(self):
        for old in ("Бабан", "1Ваня", "Я", "ъъъ", "Всё..ок.", "Ол", "Ж" * 40, "李雷"):
            nick = latin_nick(old)
            self.assertEqual(normalize_username(nick), nick, old)
        self.assertEqual(latin_nick("1Ваня"), "Vanya")
        self.assertEqual(latin_nick("Я"), "user_Ya")
        self.assertEqual(latin_nick("李雷"), "user")


class TestMigration(StarsTestBase):
    async def add(self, username: str, first_name: str | None = None) -> str:
        async with self.Session() as db:
            user = User(username=username, first_name=first_name, phone=f"+7911{len(self.users) + 100:07d}", password_hash="x")
            db.add(user)
            await db.commit()
            self.users[username] = user
            return user.id

    async def user(self, user_id: str) -> User:
        async with self.Session() as db:
            return (await db.execute(select(User).where(User.id == user_id))).scalar_one()

    async def test_migrates_cyrillic_only(self):
        baban = await self.add("Бабан")
        ivan = await self.add("Иван_Петров")
        named = await self.add("Ваня", first_name="Иван")
        # «Vanya» уже занят латинским ником в другом регистре.
        await self.add("vanya")
        clash = await self.add("ваня")

        async with self.engine.begin() as conn:
            renamed = await migrate_legacy_usernames(conn)
        self.assertEqual(renamed, 4)

        u = await self.user(baban)
        self.assertEqual((u.username, u.first_name), ("Baban", "Бабан"))
        u = await self.user(ivan)
        self.assertEqual((u.username, u.first_name), ("Ivan_Petrov", "Иван Петров"))
        # Своё имя не затираем.
        u = await self.user(named)
        self.assertEqual(u.first_name, "Иван")
        nicks = {(await self.user(named)).username.lower(), (await self.user(clash)).username.lower()}
        self.assertEqual(nicks, {"vanya_2", "vanya_3"})
        # Латинские ники не трогаем; повторный запуск ничего не меняет.
        self.assertEqual((await self.user(self.users["alice"].id)).username, "alice")
        async with self.engine.begin() as conn:
            self.assertEqual(await migrate_legacy_usernames(conn), 0)


if __name__ == "__main__":
    unittest.main()

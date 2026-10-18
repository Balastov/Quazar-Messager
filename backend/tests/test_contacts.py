"""Контакты из телефонной книги: сверка с пользователями, хранение только найденных."""

import unittest

from pydantic import ValidationError
from sqlalchemy import func, select

from app.api import contacts as api
from app.models.contact import UserContact
from tests.stars_base import StarsTestBase


def book(*entries):
    return api.SyncIn(contacts=[api.PhonebookEntry(name=n, phones=list(p)) for n, p in entries])


class TestContacts(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        api._recent_syncs.clear()
        self.addCleanup(api._recent_syncs.clear)

    async def stored_rows(self) -> int:
        async with self.Session() as db:
            return (await db.execute(select(func.count()).select_from(UserContact))).scalar_one()

    async def test_sync_keeps_only_quazar_users_with_phonebook_names(self):
        # Телефоны в базе: owner +79000000000 … carol +79000000005.
        out = await self.call(
            api.sync_contacts,
            book(
                ("  Боб   Петров ", ["8 (900) 000-00-04"]),
                ("Незнакомец", ["+7 999 111-22-33"]),
                ("Я сам", ["+79000000003"]),
                ("Кэрол", ["+1 555 0100", "79000000005", "+79000000005"]),
                ("Без номера", []),
            ),
            user="alice",
        )
        self.assertEqual([(c.name, c.user.username) for c in out.contacts], [("Боб Петров", "bob"), ("Кэрол", "carol")])
        self.assertEqual(out.total, 5)
        self.assertIsNotNone(out.synced_at)
        # Номера без совпадений и сам владелец не сохраняются.
        self.assertEqual(await self.stored_rows(), 2)
        self.assertIn((self.users["alice"].id, {"type": "contacts_updated"}), self.events)

        mine = await self.call(api.my_contacts, user="alice")
        self.assertEqual([c.user.username for c in mine.contacts], ["bob", "carol"])
        other = await self.call(api.my_contacts, user="bob")
        self.assertEqual((other.contacts, other.synced_at), ([], None))

    async def test_resync_replaces_the_list(self):
        await self.call(api.sync_contacts, book(("Боб", ["+79000000004"]), ("Кэрол", ["+79000000005"])), user="alice")
        out = await self.call(api.sync_contacts, book(("Кэролина", ["+79000000005"])), user="alice")
        self.assertEqual([(c.name, c.user.username) for c in out.contacts], [("Кэролина", "carol")])

    async def test_merge_adds_to_the_list(self):
        await self.call(api.sync_contacts, book(("Боб", ["+79000000004"])), user="alice")
        merged = api.SyncIn(
            contacts=[
                api.PhonebookEntry(name="Кэрол", phones=["+79000000005"]),
                api.PhonebookEntry(name="Бобби", phones=["+79000000004"]),
                api.PhonebookEntry(name="Чужой", phones=["+79990000000"]),
            ],
            mode="merge",
        )
        out = await self.call(api.sync_contacts, merged, user="alice")
        self.assertEqual([(c.name, c.user.username) for c in out.contacts], [("Бобби", "bob"), ("Кэрол", "carol")])
        self.assertEqual(out.total, 4)
        # Без имени прежнее имя не затирается.
        nameless = api.SyncIn(contacts=[api.PhonebookEntry(name="", phones=["+79000000005"])], mode="merge")
        out = await self.call(api.sync_contacts, nameless, user="alice")
        self.assertIn("Кэрол", [c.name for c in out.contacts])

    async def test_forget_removes_everything(self):
        await self.call(api.sync_contacts, book(("Боб", ["+79000000004"])), user="alice")
        await self.call(api.forget_contacts, user="alice")
        out = await self.call(api.my_contacts, user="alice")
        self.assertEqual((out.contacts, out.synced_at, out.total), ([], None, 0))

    async def test_rate_limited(self):
        for _ in range(api.SYNC_LIMIT_PER_HOUR):
            await self.call(api.sync_contacts, book(), user="alice")
        await self.expect_error(429, api.sync_contacts, book(), user="alice")
        # У других пользователей свой лимит.
        await self.call(api.sync_contacts, book(), user="bob")

    def test_size_limits(self):
        with self.assertRaises(ValidationError):
            api.SyncIn(contacts=[api.PhonebookEntry(name="x", phones=[])] * (api.MAX_CONTACTS + 1))
        with self.assertRaises(ValidationError):
            api.PhonebookEntry(name="x", phones=["+79000000000"] * (api.MAX_PHONES_PER_CONTACT + 1))


if __name__ == "__main__":
    unittest.main()

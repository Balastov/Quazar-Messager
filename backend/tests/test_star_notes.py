"""Заметки Спутника: правка с версиями, конфликт одновременной правки, история, права.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import json
from unittest import mock

from app.api import star_notes as notes
from app.api import stars as api
from app.schemas.star import UpdateChannel
from tests.stars_base import StarsTestBase


class StarNotesTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")

    async def save(self, text: str, base: int, user="alice"):
        return await self.call(
            notes.save_notes, self.star.id, self.sat.id, notes.SaveNote(text=text, base_version=base), user=user
        )

    async def get(self, user="bob"):
        return await self.call(notes.get_notes, self.star.id, self.sat.id, user=user)

    async def test_empty_then_versions_and_history(self):
        empty = await self.get()
        self.assertEqual((empty.text, empty.version, empty.can_edit), ("", 0, True))
        v1 = await self.save("# Онбординг\n\n- доступы", 0)
        self.assertEqual((v1.version, v1.updated_by.username), (1, "alice"))
        v2 = await self.save("# Онбординг\n\n- доступы\n- вики", 1, user="bob")
        self.assertEqual(v2.version, 2)
        # Тот же текст — новой версии нет.
        self.assertEqual((await self.save(v2.text, 2)).version, 2)
        revs = await self.call(notes.list_revisions, self.star.id, self.sat.id, user="mod")
        self.assertEqual([(r.version, r.author.username) for r in revs], [(2, "bob"), (1, "alice")])
        old = await self.call(notes.get_revision, self.star.id, self.sat.id, 1, user="mod")
        self.assertEqual(old.text, "# Онбординг\n\n- доступы")
        bob = self.users["bob"].id
        events = [e for uid, e in self.events if uid == bob and e.get("type") == "star_notes"]
        self.assertEqual([e["version"] for e in events], [1, 2])

    async def test_conflict_returns_latest(self):
        await self.save("первая", 0)
        await self.save("правка Бориса", 1, user="bob")
        resp = await self.save("правка Алисы от старой версии", 1)
        self.assertEqual(resp.status_code, 409)
        body = json.loads(resp.body)
        self.assertEqual((body["note"]["text"], body["note"]["version"]), ("правка Бориса", 2))
        self.assertEqual((await self.get()).text, "правка Бориса")

    async def test_history_is_capped(self):
        with mock.patch.object(notes, "NOTE_REVISIONS", 3):
            for v in range(5):
                await self.save(f"версия {v + 1}", v)
        revs = await self.call(notes.list_revisions, self.star.id, self.sat.id, user="bob")
        self.assertEqual([r.version for r in revs], [5, 4, 3])
        await self.expect_error(404, notes.get_revision, self.star.id, self.sat.id, 1, user="bob")

    async def test_permissions(self):
        await self.call(api.update_channel, self.star.id, self.sat.id, UpdateChannel(announcement=True), user="owner")
        self.assertFalse((await self.get()).can_edit)
        await self.expect_error(403, notes.save_notes, self.star.id, self.sat.id,
                                notes.SaveNote(text="x", base_version=0), user="bob")
        self.assertEqual((await self.save("регламент", 0, user="mod")).version, 1)
        await self.expect_error(404, notes.get_notes, self.star.id, self.sat.id, user="carol")

"""Прогресс обучения на аккаунт. Нужна PostgreSQL (см. stars_base)."""

from app.api import tutorials as api
from tests.stars_base import StarsTestBase


class TutorialsTest(StarsTestBase):
    async def test_done_sticks_and_dismissed_does_not_overwrite_it(self):
        self.assertEqual(await self.call(api.list_tutorials, user="alice"), {})
        out = await self.call(api.mark_tutorial, "main", api.TutorialMark(state="dismissed"), user="alice")
        self.assertEqual(out["main"]["state"], "dismissed")
        await self.call(api.mark_tutorial, "main", api.TutorialMark(state="done"), user="alice")
        out = await self.call(api.mark_tutorial, "main", api.TutorialMark(state="dismissed"), user="alice")
        self.assertEqual(out["main"]["state"], "done")
        self.assertEqual(set(await self.call(api.list_tutorials, user="alice")), {"main"})
        # У другого человека — своё.
        self.assertEqual(await self.call(api.list_tutorials, user="bob"), {})

    async def test_unknown_tour(self):
        await self.expect_error(404, api.mark_tutorial, "nope", api.TutorialMark(state="done"), user="alice")

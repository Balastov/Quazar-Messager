"""Сценарии Звёзд: расписание, новый участник, формы, права.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import unittest
from datetime import datetime, timezone

from pydantic import ValidationError

from app.api import workflows as api_wf
from app.api import stars as api
from app.core import workflows
from tests.stars_base import StarsTestBase


class NextRunTest(unittest.TestCase):
    def test_weekly(self):
        sched = {"days": [1], "time": "10:00", "tz": "Europe/Moscow"}
        # Пятница 31.10.2026 12:00 UTC → понедельник 02.11 10:00 МСК = 07:00 UTC.
        after = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(workflows.next_run(sched, after), datetime(2026, 11, 2, 7, 0, tzinfo=timezone.utc))
        # Ровно в момент срабатывания — уже следующая неделя.
        at = datetime(2026, 11, 2, 7, 0, tzinfo=timezone.utc)
        self.assertEqual(workflows.next_run(sched, at), datetime(2026, 11, 9, 7, 0, tzinfo=timezone.utc))
        daily = {"days": [1, 2, 3, 4, 5], "time": "09:30", "tz": "Asia/Yekaterinburg"}
        self.assertEqual(
            workflows.next_run(daily, datetime(2026, 11, 2, 3, 0, tzinfo=timezone.utc)),
            datetime(2026, 11, 2, 4, 30, tzinfo=timezone.utc),
        )

    def test_render(self):
        self.assertEqual(
            workflows.render("Привет, {user}! В {star} {unknown}", {"user": "@anna", "star": "Команда"}),
            "Привет, @anna! В Команда {unknown}",
        )

    def test_validation(self):
        for bad in (
            {"name": "x", "trigger": "schedule", "channel_id": "c", "text": "t"},
            {"name": "x", "trigger": "form", "channel_id": "c", "form": []},
            {"name": "x", "trigger": "member_joined", "channel_id": "c", "text": "  "},
            {"name": "x", "trigger": "schedule", "channel_id": "c", "text": "t",
             "schedule": {"days": [8], "time": "10:00"}},
            {"name": "x", "trigger": "schedule", "channel_id": "c", "text": "t",
             "schedule": {"days": [1], "time": "25:00"}},
            {"name": "x", "trigger": "form", "channel_id": "c",
             "form": [{"id": "a", "label": "A", "kind": "select", "options": ["one"]}]},
        ):
            with self.assertRaises(ValidationError, msg=bad):
                api_wf.WorkflowBody(**bad)


class WorkflowsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")

    async def create(self, user="owner", **body):
        return await self.call(
            api_wf.create_workflow, self.star.id, api_wf.WorkflowBody(channel_id=self.sat.id, **body), user=user
        )

    def posted(self) -> list[dict]:
        uid = self.users["owner"].id
        return [e["message"] for u, e in self.events if u == uid and e.get("type") == "star_message"]

    async def test_rights(self):
        await self.expect_error(403, api_wf.create_workflow, self.star.id, api_wf.WorkflowBody(
            name="x", trigger="member_joined", channel_id=self.sat.id, text="hi"), user="alice")

    async def test_member_joined_greets(self):
        await self.create(name="Приветствие", trigger="member_joined",
                          text="Добро пожаловать, {user}! Правила — в закреплённых.")
        await self.join(self.star.id, "carol")
        last = self.posted()[-1]
        self.assertEqual((last["kind"], last["bot_kind"], last["bot_name"]), ("bot", "workflow", "Приветствие"))
        self.assertEqual(last["text"], "Добро пожаловать, @carol! Правила — в закреплённых.")
        self.assertEqual(last["mentions"], [self.users["carol"].id])

    async def test_schedule_runs_when_due(self):
        wf = await self.create(name="Стендап", trigger="schedule", text="Что сделал вчера? {date}",
                               schedule={"days": [1, 2, 3, 4, 5], "time": "10:00", "tz": "Europe/Moscow"})
        self.assertIsNotNone(wf.next_run_at)
        async with self.Session() as db:
            self.assertEqual(await workflows.run_due(db, wf.next_run_at.replace(second=0)), 1)
            self.assertEqual(await workflows.run_due(db, wf.next_run_at), 0)  # не дважды
        self.assertTrue(self.posted()[-1]["text"].startswith("Что сделал вчера?"))
        listed = await self.call(api_wf.list_workflows, self.star.id, user="admin")
        self.assertGreater(listed[0].next_run_at, wf.next_run_at)
        # Выключенный сценарий не срабатывает.
        body = api_wf.WorkflowBody(name="Стендап", trigger="schedule", enabled=False, channel_id=self.sat.id,
                                   text="x", schedule={"days": [1], "time": "10:00"})
        off = await self.call(api_wf.update_workflow, self.star.id, wf.id, body, user="owner")
        self.assertIsNone(off.next_run_at)

    async def test_form_submission(self):
        wf = await self.create(name="Заявка на доступ", trigger="form", form=[
            {"id": "system", "label": "Система", "kind": "select", "options": ["VPN", "GitHub"]},
            {"id": "why", "label": "Зачем", "kind": "textarea"},
            {"id": "until", "label": "До какого числа", "required": False},
        ])
        forms = await self.call(api_wf.list_forms, self.star.id, user="bob")
        self.assertEqual([f.name for f in forms], ["Заявка на доступ"])
        await self.expect_error(422, api_wf.submit_form, self.star.id, wf.id,
                                api_wf.RunForm(values={"system": "VPN"}), user="bob")
        await self.expect_error(422, api_wf.submit_form, self.star.id, wf.id,
                                api_wf.RunForm(values={"system": "Jira", "why": "надо"}), user="bob")
        await self.call(api_wf.submit_form, self.star.id, wf.id,
                        api_wf.RunForm(values={"system": "GitHub", "why": "Новый проект\nнужен доступ"}), user="bob")
        text = self.posted()[-1]["text"]
        self.assertIn("**Заявка на доступ** от @bob", text)
        self.assertIn("**Система:** GitHub", text)
        self.assertIn("**Зачем:**\nНовый проект\nнужен доступ", text)
        self.assertNotIn("До какого числа", text)
        self.assertEqual(self.posted()[-1]["mentions"], [])  # «от @bob» — подпись, не упоминание
        await self.expect_error(404, api_wf.submit_form, self.star.id, wf.id, api_wf.RunForm(), user="carol")

    async def test_test_run_and_deleted_channel(self):
        wf = await self.create(name="Пятничный отчёт", trigger="schedule", text="Отчёт за неделю, {name}",
                               schedule={"days": [5], "time": "17:00"})
        await self.call(api_wf.test_workflow, self.star.id, wf.id, user="owner")
        self.assertEqual(self.posted()[-1]["text"], "Отчёт за неделю, owner")
        await self.call(api.delete_channel, self.star.id, self.sat.id, user="owner")
        self.assertEqual(await self.call(api_wf.list_workflows, self.star.id, user="owner"), [])


if __name__ == "__main__":
    unittest.main()

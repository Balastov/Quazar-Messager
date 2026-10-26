"""Интеграции: разбор событий GitHub, GitLab, Jira, Grafana, Alertmanager и свой JSON; приём по адресу.

Тесты API нужна PostgreSQL (TEST_DATABASE_URL); без базы пропускаются.
"""

import json
import unittest
from unittest import mock

from app.api import stars as api
from app.api import webhooks as hooks_api
from app.core import notify, webhooks as wh
from tests.stars_base import StarsTestBase

GRAFANA = {
    "receiver": "quazar", "status": "firing", "orgId": 1, "title": "[FIRING:1] HighCPU (prod)",
    "alerts": [
        {"status": "firing", "labels": {"alertname": "HighCPU", "instance": "web-1", "severity": "critical"},
         "annotations": {"summary": "CPU 97% больше 5 минут"}, "generatorURL": "https://grafana.example/alerting/grafana/abc/view",
         "dashboardURL": "https://grafana.example/d/xyz"},
        {"status": "resolved", "labels": {"alertname": "DiskFull", "instance": "db-1"},
         "annotations": {"description": "Место освободилось"}},
    ],
    "commonLabels": {}, "externalURL": "https://grafana.example/",
}


class RenderTest(unittest.TestCase):
    def test_grafana_unified(self):
        self.assertEqual(wh.detect({}, GRAFANA), "grafana")
        text = wh.render("auto", {}, GRAFANA)
        lines = text.splitlines()
        self.assertTrue(lines[0].startswith("🔥 Сработало: [FIRING:1] HighCPU (prod) (1 активно, 1 решено)"))
        self.assertIn("🔴 HighCPU · web-1 · critical — CPU 97% больше 5 минут", text)
        self.assertIn("   https://grafana.example/d/xyz", text)
        self.assertIn("🟢 DiskFull · db-1 — Место освободилось", text)

    def test_grafana_legacy_and_alertmanager(self):
        legacy = {"title": "[Alerting] Ошибки 5xx", "ruleName": "5xx", "state": "alerting", "message": "Больше 50 в минуту",
                  "ruleUrl": "https://grafana.example/d/1"}
        self.assertEqual(wh.render("auto", {}, legacy), "🔥 [Alerting] Ошибки 5xx\nБольше 50 в минуту\nhttps://grafana.example/d/1")
        am = {"version": "4", "receiver": "q", "status": "resolved", "groupLabels": {"alertname": "Down"},
              "alerts": [{"status": "resolved", "labels": {"alertname": "Down", "job": "api"}, "annotations": {}}]}
        self.assertEqual(wh.detect({}, am), "alertmanager")
        self.assertEqual(wh.render("auto", {}, am), "✅ Решено: Down\n🟢 Down · api")

    def test_github(self):
        push = {"ref": "refs/heads/main", "repository": {"full_name": "acme/app"}, "sender": {"login": "ann"},
                "commits": [{"id": "abcdef123", "message": "Fix login\n\nlong body"}], "compare": "https://github.com/acme/app/compare/x"}
        self.assertEqual(wh.render("auto", {"X-GitHub-Event": "push"}, push),
                         "⬆️ ann → acme/app:main — коммитов: 1\n• Fix login (abcdef1)\nhttps://github.com/acme/app/compare/x")
        pr = {"action": "closed", "repository": {"full_name": "acme/app"}, "sender": {"login": "bob"},
              "pull_request": {"number": 7, "title": "Новый вход", "merged": True, "html_url": "https://github.com/acme/app/pull/7"}}
        self.assertTrue(wh.render("github", {"X-GitHub-Event": "pull_request"}, pr).startswith("🔀 bob слил(а) PR #7 «Новый вход»"))
        with self.assertRaises(wh.Unsupported):
            wh.render("auto", {"X-GitHub-Event": "star"}, {"action": "created"})

    def test_gitlab_jira_generic(self):
        pipe = {"object_kind": "pipeline", "object_attributes": {"id": 42, "status": "failed", "ref": "main"},
                "project": {"path_with_namespace": "acme/app", "web_url": "https://gitlab.example/acme/app"}}
        self.assertEqual(wh.render("auto", {"X-Gitlab-Event": "Pipeline Hook"}, pipe),
                         "❌ Пайплайн #42 в acme/app (main): failed\nhttps://gitlab.example/acme/app/-/pipelines/42")
        jira = {"webhookEvent": "jira:issue_created", "user": {"displayName": "Иван"},
                "issue": {"key": "OPS-12", "self": "https://acme.atlassian.net/rest/api/2/issue/1", "fields": {"summary": "Упал бэкап"}}}
        self.assertEqual(wh.render("auto", {}, jira), "📌 Иван создал(а) OPS-12 «Упал бэкап»\nhttps://acme.atlassian.net/browse/OPS-12")
        self.assertEqual(wh.render("auto", {}, {"title": "Деплой", "text": "v1.2 выкачен"}), "Деплой\nv1.2 выкачен")
        with self.assertRaises(wh.Unsupported):
            wh.render("generic", {}, {"foo": 1})


class FakeRequest:
    def __init__(self, body: bytes, headers: dict | None = None):
        self.body = body
        self.headers = headers or {"content-type": "application/json"}

    async def stream(self):
        yield self.body


class WebhookApiTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pushes: list[list[str]] = []
        patcher = mock.patch.object(notify, "push_later", lambda ids, payload: self.pushes.append(ids))
        patcher.start()
        self.addCleanup(patcher.stop)
        hooks_api._recent.clear()
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")

    async def receive(self, hook, body, headers=None, token=None):
        async with self.Session() as db:
            return await hooks_api.receive(hook.id, token or hook.token, FakeRequest(json.dumps(body).encode(), headers), db)

    async def test_create_receive_and_rotate(self):
        await self.expect_error(403, hooks_api.create_webhook, self.star.id, self.sat.id,
                                hooks_api.CreateWebhook(name="Grafana"), user="alice")
        hook = await self.call(hooks_api.create_webhook, self.star.id, self.sat.id,
                               hooks_api.CreateWebhook(name="Grafana"), user="admin")
        out = await self.receive(hook, GRAFANA)
        self.assertTrue(out["posted"])
        feed = await self.call(api.list_messages, self.star.id, self.sat.id, user="bob", limit=50, before_id=None)
        self.assertEqual((feed[-1].kind, feed[-1].bot_name, feed[-1].bot_kind, feed[-1].sender), ("bot", "Grafana", "grafana", None))
        self.assertTrue(feed[-1].text.startswith("🔥 Сработало"))

        # Неинтересное событие GitHub — принимаем без сообщения и пишем причину.
        out = await self.receive(hook, {"action": "created"}, {"X-GitHub-Event": "star"})
        self.assertFalse(out["posted"])
        listed = await self.call(hooks_api.list_webhooks, self.star.id, user="admin")
        self.assertIn("star", listed[0].last_error)

        # Свой JSON без текста — 422; чужой токен — 404; перевыпуск — старый адрес больше не работает.
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            await self.receive(hook, {"foo": 1})
        self.assertEqual(ctx.exception.status_code, 422)
        with self.assertRaises(HTTPException) as ctx:
            await self.receive(hook, {"text": "x"}, token="wrong")
        self.assertEqual(ctx.exception.status_code, 404)
        rotated = await self.call(hooks_api.update_webhook, self.star.id, hook.id, hooks_api.UpdateWebhook(new_token=True), user="admin")
        with self.assertRaises(HTTPException):
            await self.receive(hook, {"text": "x"})
        self.assertTrue((await self.receive(rotated, {"text": "по новому адресу"}))["posted"])

        await self.call(hooks_api.delete_webhook, self.star.id, hook.id, user="owner")
        self.assertEqual(await self.call(hooks_api.list_webhooks, self.star.id, user="admin"), [])
        # Сообщения остались — с именем интеграции.
        feed = await self.call(api.list_messages, self.star.id, self.sat.id, user="bob", limit=50, before_id=None)
        self.assertEqual(feed[-1].bot_name, "Grafana")

    async def test_rate_limit(self):
        hook = await self.call(hooks_api.create_webhook, self.star.id, self.sat.id,
                               hooks_api.CreateWebhook(name="Спам", kind="generic"), user="admin")
        from fastapi import HTTPException
        for i in range(hooks_api.RATE):
            await self.receive(hook, {"text": f"#{i}"})
        with self.assertRaises(HTTPException) as ctx:
            await self.receive(hook, {"text": "лишнее"})
        self.assertEqual(ctx.exception.status_code, 429)

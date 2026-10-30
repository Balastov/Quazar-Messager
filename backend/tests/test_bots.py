"""Боты Звёзд: настройка, токен, Bot API, события с подписью, кнопки, защита адреса событий.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

import asyncio
import hashlib
import hmac
import json
import unittest
from unittest import mock

import httpx
from fastapi import HTTPException

from app.api import bots as api_bots
from app.api import stars as api
from app.core import bots
from app.core.link_preview import Blocked
from app.models.star import StarBot
from app.schemas.star import BotButton, SendStarMessage
from tests.stars_base import StarsTestBase


class TokenTest(unittest.TestCase):
    def test_token_roundtrip(self):
        token, token_hash = bots.new_token("bot-1")
        bot_id, secret = bots.parse_token(token)
        self.assertEqual(bot_id, "bot-1")
        self.assertTrue(bots.token_matches(secret, token_hash))
        self.assertFalse(bots.token_matches(secret + "x", token_hash))
        for bad in ("", "qzb", "qzb..x", "abc.bot.secret", "qzb.a.b.c"):
            self.assertIsNone(bots.parse_token(bad))

    def test_private_addresses_are_blocked(self):
        for url in ("http://127.0.0.1:8000/x", "http://10.0.0.5/hook", "http://[::1]/", "http://169.254.169.254/"):
            with self.assertRaises(Blocked, msg=url):
                asyncio.run(bots.check_events_url(url))
        with self.assertRaises(bots.DeliveryError):
            asyncio.run(bots.deliver("http://192.168.1.1/hook", "s", {"type": "message"}))


class BotsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles(kind="work")
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")
        self.other = await self.make_star(kind="work", user="carol", name="Чужая")
        # Адрес событий «публичный», а запросы ловим сами.
        self.requests: list[httpx.Request] = []
        self.reply: httpx.Response = httpx.Response(200)

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            return self.reply

        for name, value in (
            ("transport", httpx.MockTransport(handler)),
            ("check_events_url", mock.AsyncMock()),
            ("session_factory", self.Session),
        ):
            patcher = mock.patch.object(bots, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def create(self, url="https://bot.example.com/events", user="owner", **kw):
        return await self.call(
            api_bots.create_bot, self.star.id, api_bots.BotBody(name="Деплой-бот", events_url=url, **kw), user=user
        )

    async def as_bot(self, secrets: api_bots.BotSecrets) -> StarBot:
        async with self.Session() as db:
            return await api_bots.current_bot(db, f"Bearer {secrets.token}")

    async def bot_call(self, fn, *args, bot: StarBot, **kwargs):
        async with self.Session() as db:
            bot = await db.get(StarBot, bot.id)
            return await fn(*args, bot=bot, db=db, **kwargs)

    async def settle(self):
        for _ in range(5):
            await asyncio.sleep(0.05)

    async def test_create_requires_channel_rights_and_hides_token(self):
        await self.expect_error(403, api_bots.create_bot, self.star.id, api_bots.BotBody(name="x"), user="alice")
        made = await self.create()
        self.assertTrue(made.token.startswith(f"qzb.{made.bot.id}."))
        listed = await self.call(api_bots.list_bots, self.star.id, user="admin")
        self.assertEqual([b.name for b in listed], ["Деплой-бот"])
        self.assertNotIn("token", listed[0].model_dump())
        # Перевыпуск — старый токен больше не действует.
        fresh = await self.call(api_bots.reissue_secrets, self.star.id, made.bot.id, user="owner")
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as ctx:
                await api_bots.current_bot(db, f"Bearer {made.token}")
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertEqual((await api_bots.current_bot(db, f"Bearer {fresh.token}")).id, made.bot.id)

    async def test_bot_posts_only_into_its_star(self):
        bot = await self.as_bot(await self.create(url=None))
        channels = await self.bot_call(api_bots.bot_channels, bot=bot)
        self.assertIn(self.sat.id, [c.id for c in channels])
        out = await self.bot_call(
            api_bots.bot_send, self.sat.id,
            api_bots.BotSend(text="Сборка #42 готова, @alice", buttons=[BotButton(id="ok", label="Выкатить", style="primary")]),
            bot=bot,
        )
        self.assertEqual((out.kind, out.bot_name, out.bot_id), ("bot", "Деплой-бот", bot.id))
        self.assertEqual(out.mentions, [self.users["alice"].id])
        self.assertEqual(out.buttons[0].label, "Выкатить")
        other_sat = next(c for c in self.other.channels if c.kind == "satellite")
        with self.assertRaises(HTTPException) as ctx:
            await self.bot_call(api_bots.bot_send, other_sat.id, api_bots.BotSend(text="x"), bot=bot)
        self.assertEqual(ctx.exception.status_code, 404)
        # Чужие сообщения бот не правит.
        human = await self.call(api.send_message, self.star.id, self.sat.id, SendStarMessage(text="моё"), user="alice")
        with self.assertRaises(HTTPException):
            await self.bot_call(api_bots.bot_edit, human.id, api_bots.BotEdit(text="взлом"), bot=bot)
        with self.assertRaises(HTTPException) as ctx:
            await self.bot_call(api_bots.bot_send, self.sat.id, api_bots.BotSend(
                text="x", buttons=[BotButton(id="a", label="1"), BotButton(id="a", label="2")]), bot=bot)
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_new_messages_reach_the_bot_signed(self):
        made = await self.create()
        await self.call(api.send_message, self.star.id, self.sat.id, SendStarMessage(text="привет, бот"), user="alice")
        await self.settle()
        self.assertEqual(len(self.requests), 1)
        req = self.requests[0]
        self.assertEqual(req.headers["x-quazar-event"], "message")
        expected = "sha256=" + hmac.new(made.signing_secret.encode(), req.content, hashlib.sha256).hexdigest()
        self.assertEqual(req.headers["x-quazar-signature"], expected)
        event = json.loads(req.content)
        self.assertEqual((event["type"], event["message"]["text"]), ("message", "привет, бот"))
        # Свои сообщения бот себе не получает; выключенные события — не шлём.
        bot = await self.as_bot(made)
        await self.bot_call(api_bots.bot_send, self.sat.id, api_bots.BotSend(text="я бот"), bot=bot)
        await self.call(api_bots.update_bot, self.star.id, made.bot.id,
                        api_bots.BotBody(name="Деплой-бот", events_url="https://bot.example.com/events", message_events=False),
                        user="owner")
        await self.call(api.send_message, self.star.id, self.sat.id, SendStarMessage(text="ещё"), user="alice")
        await self.settle()
        self.assertEqual(len(self.requests), 1)

    async def test_button_press_updates_the_message(self):
        made = await self.create(message_events=False)
        bot = await self.as_bot(made)
        msg = await self.bot_call(api_bots.bot_send, self.sat.id, api_bots.BotSend(
            text="Выкатить релиз?", buttons=[BotButton(id="approve", label="Одобрить"), BotButton(id="reject", label="Отклонить")]),
            bot=bot)
        self.reply = httpx.Response(200, json={"text": "✅ Одобрил @bob", "buttons": [], "notice": "Принято"})
        out = await self.call(api_bots.press_button, self.star.id, self.sat.id, msg.id, "approve", user="bob")
        self.assertEqual(out.notice, "Принято")
        event = json.loads(self.requests[-1].content)
        self.assertEqual((event["type"], event["button_id"], event["user"]["username"]), ("button", "approve", "bob"))
        edited = [e for _, e in self.events if e.get("type") == "star_message_edited"][-1]
        self.assertEqual((edited["text"], edited["buttons"]), ("✅ Одобрил @bob", []))
        # Кнопок больше нет — нажать нечего.
        await self.expect_error(404, api_bots.press_button, self.star.id, self.sat.id, msg.id, "approve", user="bob")

    async def test_button_press_when_bot_fails(self):
        made = await self.create(message_events=False)
        bot = await self.as_bot(made)
        msg = await self.bot_call(api_bots.bot_send, self.sat.id, api_bots.BotSend(
            text="?", buttons=[BotButton(id="go", label="Поехали")]), bot=bot)
        self.reply = httpx.Response(500)
        await self.expect_error(502, api_bots.press_button, self.star.id, self.sat.id, msg.id, "go", user="bob")
        listed = await self.call(api_bots.list_bots, self.star.id, user="owner")
        self.assertIn("500", listed[0].last_error)
        await self.expect_error(404, api_bots.press_button, self.star.id, self.sat.id, msg.id, "nope", user="bob")


if __name__ == "__main__":
    unittest.main()

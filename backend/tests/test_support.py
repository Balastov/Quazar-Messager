"""Обратная связь: обращения через форму и чат с Quazar_Admin_bot, разбор в «Чёрной дыре».

Нужна PostgreSQL (TEST_DATABASE_URL); таблицы — в схеме quazar_test. Без базы тесты пропускаются.
"""

import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import admin as admin_api
from app.api import attachments as attachments_api
from app.api import chats as chats_api
from app.api import messages as messages_api
from app.api import support as api
from app.api import users as users_api
from app.core import attachments, support
from app.core.config import settings
from app.core.database import Base
from app.core.profile import normalize_username
from app.models.attachment import Attachment
from app.models.message import Message
from app.models.support import SupportMessage, SupportTicket
from app.models.user import User
from app.schemas.chat import CreateDirectChat, SetChatTtl
from app.schemas.message import EditMessage, SendMessage
from app.schemas.support import CreateTicket, TicketReply, TicketStatusBody

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://quazar:quazar@localhost:5432/quazar"
)
SCHEMA = "quazar_test"


class FakeRequest:
    def __init__(self, body: bytes):
        self.body = body
        self.headers = {"content-length": str(len(body))}

    async def stream(self):
        yield self.body


class SupportTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        admin_engine = create_async_engine(DATABASE_URL)
        try:
            async with admin_engine.begin() as conn:
                await conn.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
                await conn.execute(text(f"CREATE SCHEMA {SCHEMA}"))
        except Exception as exc:  # noqa: BLE001
            await admin_engine.dispose()
            self.skipTest(f"PostgreSQL недоступна: {exc}")
        await admin_engine.dispose()

        self.engine = create_async_engine(
            DATABASE_URL, connect_args={"server_settings": {"search_path": SCHEMA}}
        )
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)

        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, True)
        for name, value in (("MEDIA_ROOT", self.media), ("MEDIA_MIN_FREE_MB", 0)):
            patcher = mock.patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        self.events: list[tuple[str, dict]] = []

        async def broadcast(user_ids, event, exclude_user=None):
            self.events.extend((uid, event) for uid in user_ids if uid != exclude_user)

        async def send(user_id, event):
            self.events.append((user_id, event))

        patcher = mock.patch.multiple(messages_api.manager, broadcast_to_users=broadcast, send_to_user=send)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.users: dict[str, User] = {}
        async with self.Session() as db:
            for i, name in enumerate(["alice", "bob", "carol"]):
                self.users[name] = User(
                    username=name, phone=f"+7900000004{i}", password_hash="x", is_superuser=name == "carol"
                )
                db.add(self.users[name])
            await db.commit()

    async def asyncTearDown(self):
        if hasattr(self, "engine"):
            async with self.engine.begin() as conn:
                await conn.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
            await self.engine.dispose()

    # --- helpers ---

    async def call(self, fn, *args, user: str, **kwargs):
        async with self.Session() as db:
            return await fn(*args, current_user=self.users[user], db=db, **kwargs)

    async def sup(self, fn, *args, **kwargs):
        async with self.Session() as db:
            return await fn(*args, me=self.users["carol"], db=db, **kwargs)

    async def expect_error(self, status_code: int, fn, *args, user: str, **kwargs) -> HTTPException:
        with self.assertRaises(HTTPException) as ctx:
            await self.call(fn, *args, user=user, **kwargs)
        self.assertEqual(ctx.exception.status_code, status_code, ctx.exception.detail)
        return ctx.exception

    async def ticket(self, kind="bug", body="Не грузится аватар", user="alice", images=()):
        return await self.call(
            api.create_ticket, CreateTicket(kind=kind, text=body, images=list(images)), user=user
        )

    async def chat_messages(self, chat_id: str, user="alice"):
        return await self.call(messages_api.get_messages, chat_id, user=user, limit=50, before_id=None)

    async def say(self, chat_id: str, payload: str, user="alice", **kwargs):
        return await self.call(messages_api.send_message, chat_id, SendMessage(payload=payload, **kwargs), user=user)

    async def upload(self, chat_id: str, user="alice") -> str:
        out = await self.call(attachments_api.upload_attachment, chat_id, FakeRequest(b"\x00" * 100), user=user)
        return out.id

    def image(self, attachment_id: str) -> dict:
        return {"id": attachment_id, "key": "a2V5", "mime": "image/png", "w": 10, "h": 20, "size": 100}

    def uid(self, name: str) -> str:
        return self.users[name].id

    def events_of(self, kind: str) -> list[tuple[str, dict]]:
        return [(uid, e) for uid, e in self.events if e["type"] == kind]

    async def tickets(self) -> list[SupportTicket]:
        async with self.Session() as db:
            return list((await db.execute(select(SupportTicket).order_by(SupportTicket.number))).scalars())

    # --- Форма ---

    async def test_form_ticket_lands_in_the_bot_chat(self):
        chat = await self.call(api.open_support_chat, user="alice")
        self.assertEqual(chat.type, "support")
        bot = next(m.user for m in chat.members if m.user.id != self.uid("alice"))
        self.assertEqual((bot.username, bot.is_official), (support.BOT_USERNAME, True))
        # Тот же чат при повторном открытии.
        self.assertEqual((await self.call(api.open_support_chat, user="alice")).id, chat.id)

        attachment_id = await self.upload(chat.id)
        ticket = await self.ticket(images=[self.image(attachment_id)])
        self.assertEqual((ticket.number, ticket.kind, ticket.status), (1, "bug", "queued"))
        self.assertEqual(ticket.chat_id, chat.id)

        card, ack = await self.chat_messages(chat.id)
        self.assertEqual(card.sender_id, self.uid("alice"))
        self.assertEqual(card.status, "delivered")  # бот «получил» сразу
        data = json.loads(card.payload.removeprefix(support.TICKET_PREFIX))
        self.assertEqual((data["number"], data["text"], data["status"]), (1, "Не грузится аватар", "queued"))
        self.assertEqual(data["images"][0]["id"], attachment_id)
        self.assertEqual(ack.sender_id, bot.id)
        # Сразу после карточки — без цитаты: и так понятно, о чём речь.
        self.assertIsNone(ack.reply_to)
        self.assertIn("№1", ack.payload)
        async with self.Session() as db:
            self.assertEqual((await db.get(Attachment, attachment_id)).message_id, card.id)
        # «Чёрная дыра» у владельца ресурса обновляется.
        self.assertIn(self.uid("carol"), [uid for uid, _ in self.events_of("support_ticket")])

        # Номера сквозные; чужую картинку не прикрепить.
        self.assertEqual((await self.ticket(kind="idea", body="Тёмная тема")).number, 2)
        bob_chat = await self.call(api.open_support_chat, user="bob")
        await self.expect_error(
            422, api.create_ticket,
            CreateTicket(kind="idea", text="x", images=[self.image(await self.upload(bob_chat.id, user="bob"))]),
            user="alice",
        )

    async def test_form_validation(self):
        for bad in (
            {"kind": "bug", "text": "   "},
            {"kind": "spam", "text": "x"},
            {"kind": "bug", "text": "x", "images": [self.image("00000000-0000-0000-0000-00000000000" + str(i)) for i in range(6)]},
        ):
            with self.assertRaises(ValidationError):
                CreateTicket(**bad)

    # --- Просто написать боту ---

    async def test_free_messages_join_the_open_ticket_or_start_a_question(self):
        chat = await self.call(api.open_support_chat, user="alice")
        first = await self.say(chat.id, "Как поменять фон?")
        (ticket,) = await self.tickets()
        self.assertEqual((ticket.kind, ticket.text, ticket.message_id), ("question", "Как поменять фон?", first.id))
        await self.say(chat.id, "В группе")
        self.assertEqual(len(await self.tickets()), 1)
        # Бот ответил один раз — на первое сообщение.
        bot_msgs = [m for m in await self.chat_messages(chat.id) if m.sender_id != self.uid("alice")]
        self.assertEqual(len(bot_msgs), 1)

        await self.sup(api.set_ticket_status, ticket.id, TicketStatusBody(status="done"))
        await self.say(chat.id, "Ещё вопрос")
        self.assertEqual(len(await self.tickets()), 2)
        # Ответ на карточку закрытого обращения — дописка к нему, а не новое.
        await self.say(chat.id, "А по первому — спасибо", reply_to_id=first.id)
        self.assertEqual(len(await self.tickets()), 2)
        detail = await self.sup(api.get_ticket, ticket.id)
        self.assertEqual(
            [m.payload for m in detail.messages if m.sender == "user"],
            ["Как поменять фон?", "В группе", "А по первому — спасибо"],
        )
        # Разговор шёл о первом — ответ по второму цитирует его начало.
        second = (await self.tickets())[1]
        await self.sup(api.reply_ticket, second.id, TicketReply(text="Отвечаем на второй"))
        last = (await self.chat_messages(chat.id))[-1]
        self.assertEqual((last.payload, last.reply_to.id), ("Отвечаем на второй", second.message_id))

    async def test_support_chat_rules(self):
        chat = await self.call(api.open_support_chat, user="alice")
        await self.expect_error(422, messages_api.send_message, chat.id, SendMessage(payload="ENC2:x"), user="alice")
        await self.expect_error(422, messages_api.send_message, chat.id, SendMessage(payload="TKT1:{}"), user="alice")
        await self.ticket()
        card = (await self.chat_messages(chat.id))[0]
        await self.expect_error(
            422, messages_api.edit_message, chat.id, card.id, EditMessage(payload="другое"), user="alice"
        )
        await self.expect_error(422, chats_api.set_chat_ttl, chat.id, SetChatTtl(ttl_seconds=3600), user="alice")
        bot_id = next(m.user.id for m in chat.members if m.user.id != self.uid("alice"))
        await self.expect_error(422, chats_api.create_direct_chat, CreateDirectChat(user_id=bot_id), user="alice")
        found = await self.call(users_api.search_users, "quazar", user="alice")
        self.assertEqual(found, [])
        # Ник под официальный аккаунт не занять (фильтр ников, app.core.censor).
        for nick in ("Quazar_Admin_bot", "quazar.support", "QuazarTeam", "kvazar_bot"):
            with self.assertRaises(ValueError):
                normalize_username(nick)

    async def test_chat_list_shows_the_bot_chat(self):
        await self.ticket()
        chats = await self.call(chats_api.list_chats, user="alice")
        (row,) = [c for c in chats if c.type == "support"]
        self.assertEqual(row.unread_count, 1)  # «Спасибо, принято»
        self.assertTrue(row.last_message.payload.startswith("Спасибо"))

    # --- «Чёрная дыра» ---

    async def test_team_reads_replies_and_moves_status(self):
        ticket = await self.ticket()
        await self.ticket(kind="idea", body="Тёмная тема", user="bob")
        listed = await self.sup(api.list_tickets, status_filter="open", kind=None, limit=100)
        self.assertEqual({t.author.username for t in listed}, {"alice", "bob"})
        self.assertEqual([t.unread for t in listed], [1, 1])
        only_bugs = await self.sup(api.list_tickets, status_filter="open", kind="bug", limit=100)
        self.assertEqual([t.id for t in only_bugs], [ticket.id])
        self.assertEqual((await self.sup(admin_api.admin_me)).queued_tickets, 2)

        # Открыли — у автора две зелёные.
        self.events.clear()
        detail = await self.sup(api.get_ticket, ticket.id)
        self.assertEqual(detail.unread, 0)
        self.assertEqual([e["status"] for uid, e in self.events_of("message_status") if uid == self.uid("alice")], ["read"])

        detail = await self.sup(api.reply_ticket, ticket.id, TicketReply(text="Поправили, обновите страницу"))
        reply = detail.messages[-1]
        self.assertEqual((reply.sender, reply.admin.username), ("bot", "carol"))
        msgs = await self.chat_messages(ticket.chat_id)
        self.assertEqual(msgs[-1].payload, "Поправили, обновите страницу")
        self.assertIsNone(msgs[-1].reply_to)

        self.events.clear()
        detail = await self.sup(api.set_ticket_status, ticket.id, TicketStatusBody(status="in_progress"))
        self.assertEqual(detail.status, "in_progress")
        (_, edited), = [(u, e) for u, e in self.events_of("message_edited") if u == self.uid("alice")]
        self.assertIsNone(edited["edited_at"])
        self.assertEqual(json.loads(edited["payload"].removeprefix(support.TICKET_PREFIX))["status"], "in_progress")
        msgs = await self.chat_messages(ticket.chat_id)
        self.assertIn("в работу", msgs[-1].payload)
        self.assertIsNone(msgs[0].edited_at)
        # Тот же статус — ничего не происходит.
        await self.sup(api.set_ticket_status, ticket.id, TicketStatusBody(status="in_progress"))
        self.assertEqual(len(await self.chat_messages(ticket.chat_id)), len(msgs))

        await self.sup(api.set_ticket_status, ticket.id, TicketStatusBody(status="done"))
        open_now = await self.sup(api.list_tickets, status_filter="open", kind=None, limit=100)
        self.assertEqual([t.author.username for t in open_now], ["bob"])
        done = await self.sup(api.list_tickets, status_filter="done", kind=None, limit=100)
        self.assertEqual([t.id for t in done], [ticket.id])

    async def test_team_sees_the_images_until_they_expire(self):
        chat = await self.call(api.open_support_chat, user="alice")
        attachment_id = await self.upload(chat.id)
        ticket = await self.ticket(images=[self.image(attachment_id)])
        response = await self.sup(api.ticket_attachment, ticket.id, attachment_id)
        self.assertTrue(str(response.path).endswith(attachment_id))
        other = await self.ticket(user="bob")
        with self.assertRaises(HTTPException):
            await self.sup(api.ticket_attachment, other.id, attachment_id)

        # 30 дней — даже если общий срок хранения отключён.
        with mock.patch.object(settings, "ATTACHMENT_TTL_DAYS", 0):
            async with self.Session() as db:
                await db.execute(
                    update(Attachment)
                    .where(Attachment.id == attachment_id)
                    .values(created_at=datetime.now(timezone.utc) - timedelta(days=31))
                )
                await db.commit()
                await attachments.sweep(db)
        with self.assertRaises(HTTPException) as ctx:
            await self.sup(api.ticket_attachment, ticket.id, attachment_id)
        self.assertEqual(ctx.exception.status_code, 404)
        # Само обращение и ссылка на картинку остаются.
        async with self.Session() as db:
            kept = await db.get(SupportTicket, ticket.id)
            self.assertEqual(kept.images[0]["id"], attachment_id)
            self.assertTrue(
                (await db.execute(select(SupportMessage).where(SupportMessage.ticket_id == ticket.id))).first()
            )
            self.assertIsNotNone(await db.get(Message, kept.message_id))

    async def test_rate_limit(self):
        with mock.patch.object(api, "TICKETS_PER_DAY", 2):
            await self.ticket()
            await self.ticket()
            await self.expect_error(
                429, api.create_ticket, CreateTicket(kind="bug", text="ещё"), user="alice"
            )

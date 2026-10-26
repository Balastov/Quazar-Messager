"""Закреплённые сообщения (чаты и Спутники) и поиск по Спутникам.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

from app.api import messages as messages_api
from app.api import pins
from app.api import search
from app.api import stars as api
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.schemas.star import SendStarMessage
from tests.stars_base import StarsTestBase


class PinsSearchTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles()
        self.sat = next(c for c in self.star.channels if c.kind == "satellite")
        async with self.Session() as db:
            self.direct = Chat(type="direct")
            self.group = Chat(type="group", name="Команда")
            db.add_all([self.direct, self.group])
            await db.flush()
            db.add_all([
                ChatMember(chat_id=self.direct.id, user_id=self.users["alice"].id),
                ChatMember(chat_id=self.direct.id, user_id=self.users["bob"].id),
                ChatMember(chat_id=self.group.id, user_id=self.users["alice"].id, role="owner"),
                ChatMember(chat_id=self.group.id, user_id=self.users["bob"].id),
            ])
            self.msgs = [Message(chat_id=self.direct.id, sender_id=self.users["bob"].id, payload=f"ENC2:{i}") for i in range(2)]
            self.group_msg = Message(chat_id=self.group.id, sender_id=self.users["bob"].id, payload="план")
            db.add_all([*self.msgs, self.group_msg])
            await db.commit()

    def events_of(self, kind: str) -> list[dict]:
        return [e for _, e in self.events if e["type"] == kind]

    async def say(self, text: str, user="alice", **kw):
        return await self.call(api.send_message, self.star.id, self.sat.id, SendStarMessage(text=text, **kw), user=user)

    async def test_chat_pins(self):
        await self.call(pins.pin_chat_message, self.direct.id, self.msgs[0].id, user="bob")
        await self.call(pins.pin_chat_message, self.direct.id, self.msgs[1].id, user="alice")
        listed = await self.call(pins.list_chat_pins, self.direct.id, user="alice")
        self.assertEqual([m.id for m in listed], [self.msgs[1].id, self.msgs[0].id])  # свежие первыми
        self.assertEqual(self.events_of("chat_pins")[-1]["message_ids"], [self.msgs[1].id, self.msgs[0].id])

        # В группе — только владелец и админы.
        await self.expect_error(403, pins.pin_chat_message, self.group.id, self.group_msg.id, user="bob")
        await self.call(pins.pin_chat_message, self.group.id, self.group_msg.id, user="alice")
        await self.expect_error(403, pins.list_chat_pins, self.group.id, user="carol")

        # Удалили сообщение — закреп ушёл вместе с ним.
        await self.call(messages_api.delete_message, self.direct.id, self.msgs[0].id, user="bob")
        listed = await self.call(pins.list_chat_pins, self.direct.id, user="alice")
        self.assertEqual([m.id for m in listed], [self.msgs[1].id])
        await self.call(pins.unpin_chat_message, self.direct.id, self.msgs[1].id, user="bob")
        self.assertEqual(await self.call(pins.list_chat_pins, self.direct.id, user="alice"), [])

    async def test_star_pins(self):
        msg = await self.say("Правила дежурств")
        await self.expect_error(403, pins.pin_star_message, self.star.id, self.sat.id, msg.id, user="alice")
        await self.call(pins.pin_star_message, self.star.id, self.sat.id, msg.id, user="mod")
        listed = await self.call(pins.list_star_pins, self.star.id, self.sat.id, user="bob")
        self.assertEqual([m.text for m in listed], ["Правила дежурств"])
        self.assertEqual(self.events_of("star_pins")[-1]["message_ids"], [msg.id])
        reply = await self.say("ответ", thread_id=msg.id)
        await self.expect_error(422, pins.pin_star_message, self.star.id, self.sat.id, reply.id, user="mod")
        await self.call(pins.unpin_star_message, self.star.id, self.sat.id, msg.id, user="admin")
        self.assertEqual(await self.call(pins.list_star_pins, self.star.id, self.sat.id, user="bob"), [])

    async def test_star_search(self):
        await self.say("Релиз во вторник")
        root = await self.say("Смета на ремонт офиса", user="bob")
        await self.say("в смете ошибка", thread_id=root.id)
        await self.say("100%_скидка")

        async def find(q, **kw):
            out = await self.call(search.search_messages, self.star.id, user="bob", q=q,
                                  channel_id=kw.get("channel_id"), before=None, limit=30)
            return [m.text for m in out]

        self.assertEqual(await find("СМЕТ"), ["в смете ошибка", "Смета на ремонт офиса"])
        self.assertEqual(await find("смета офис"), ["Смета на ремонт офиса"])
        self.assertEqual(await find("100%_"), ["100%_скидка"])  # % и _ — буквально
        self.assertEqual(await find("0%"), ["100%_скидка"])
        await self.expect_error(404, search.search_messages, self.star.id, user="carol", q="смета",
                                channel_id=None, before=None, limit=30)

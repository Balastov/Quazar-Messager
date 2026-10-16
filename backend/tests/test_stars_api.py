"""Сценарии API Созвездия на настоящей PostgreSQL.

База берётся из TEST_DATABASE_URL (по умолчанию — локальная dev-база), но все таблицы
создаются в отдельной схеме quazar_test, которая пересоздаётся перед каждым тестом.
Если база недоступна, тесты пропускаются.
"""

import os
import unittest
from unittest import mock

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import stars as api
from app.core import stars as rules
from app.core.database import Base
from app.models.user import User
from app.schemas.star import (
    CreateChannel,
    CreateInvite,
    CreateStar,
    SendStarMessage,
    TransferStar,
    UpdateMemberRole,
    UpdateRolePermissions,
)

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://quazar:quazar@localhost:5432/quazar"
)
SCHEMA = "quazar_test"


class StarsApiTest(unittest.IsolatedAsyncioTestCase):
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

        # Перехватываем рассылку по WebSocket.
        self.events: list[tuple[str, dict]] = []

        async def broadcast(user_ids, event, exclude_user=None):
            for uid in user_ids:
                self.events.append((uid, event))

        async def send(user_id, event):
            self.events.append((user_id, event))

        patcher = mock.patch.multiple(api.manager, broadcast_to_users=broadcast, send_to_user=send)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.users: dict[str, User] = {}
        async with self.Session() as db:
            for i, name in enumerate(["owner", "admin", "mod", "alice", "bob", "carol"]):
                user = User(username=name, phone=f"+7900000000{i}", password_hash="x")
                db.add(user)
                self.users[name] = user
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

    async def expect_error(self, status_code: int, fn, *args, user: str, **kwargs) -> HTTPException:
        with self.assertRaises(HTTPException) as ctx:
            await self.call(fn, *args, user=user, **kwargs)
        self.assertEqual(ctx.exception.status_code, status_code, ctx.exception.detail)
        return ctx.exception

    async def make_star(self, kind="gaming", user="owner", name="Звезда"):
        return await self.call(api.create_star, CreateStar(name=name, kind=kind), user=user)

    async def join(self, star_id: str, user: str, inviter="owner"):
        invite = await self.call(api.create_invite, star_id, CreateInvite(), user=inviter)
        return await self.call(api.join_by_invite, invite.code, user=user)

    async def star_with_roles(self, kind="gaming"):
        star = await self.make_star(kind)
        for name in ("admin", "mod", "alice", "bob"):
            await self.join(star.id, name)
        uid = lambda n: self.users[n].id  # noqa: E731
        await self.call(api.update_member_role, star.id, uid("admin"), UpdateMemberRole(role="admin"), user="owner")
        await self.call(api.update_member_role, star.id, uid("mod"), UpdateMemberRole(role="moderator"), user="owner")
        return star

    # --- Звёзды и лимит владения ---

    async def test_create_gaming_star_with_default_channels(self):
        star = await self.make_star("gaming")
        self.assertEqual(star.my_role, "owner")
        kinds = sorted(c.kind for c in star.channels)
        self.assertEqual(kinds, ["planet", "satellite"])

    async def test_work_star_rooms(self):
        star = await self.make_star("work")
        rooms = {c.room_kind: c.capacity for c in star.channels if c.kind == "planet"}
        self.assertEqual(rooms, {"coworking": 20, "meeting": 8})

    async def test_only_two_owned_stars_and_slot_frees_on_delete(self):
        first = await self.make_star()
        await self.make_star()
        await self.expect_error(409, api.create_star, CreateStar(name="Третья", kind="work"), user="owner")

        # Вступать в чужие Звёзды лимит не мешает.
        other = await self.make_star(user="alice")
        await self.join(other.id, "owner", inviter="alice")

        await self.call(api.delete_star, first.id, user="owner")
        await self.make_star()

    async def test_transfer_requires_free_slot_and_frees_owner_slot(self):
        star = await self.make_star()
        await self.make_star()
        await self.join(star.id, "alice")
        await self.make_star(user="alice")
        await self.make_star(user="alice")

        await self.expect_error(
            409, api.transfer_star, star.id, TransferStar(user_id=self.users["alice"].id), user="owner"
        )

        await self.join(star.id, "bob")
        detail = await self.call(api.transfer_star, star.id, TransferStar(user_id=self.users["bob"].id), user="owner")
        self.assertEqual(detail.owner_id, self.users["bob"].id)
        self.assertEqual(detail.my_role, "admin")
        # У прежнего владельца освободилось место.
        await self.make_star()

    async def test_owner_cannot_leave(self):
        star = await self.make_star()
        await self.expect_error(400, api.leave_star, star.id, user="owner")

    async def test_non_member_sees_404(self):
        star = await self.make_star()
        await self.expect_error(404, api.get_star, star.id, user="carol")

    # --- Приглашения, лимит участников, исключение и блокировка ---

    async def test_member_limit(self):
        star = await self.make_star()
        with mock.patch.object(rules, "MAX_STAR_MEMBERS", 3):
            await self.join(star.id, "alice")
            await self.join(star.id, "bob")
            invite = await self.call(api.create_invite, star.id, CreateInvite(), user="owner")
            await self.expect_error(409, api.join_by_invite, invite.code, user="carol")

    async def test_invite_max_uses(self):
        star = await self.make_star()
        invite = await self.call(api.create_invite, star.id, CreateInvite(max_uses=1), user="owner")
        await self.call(api.join_by_invite, invite.code, user="alice")
        await self.expect_error(404, api.join_by_invite, invite.code, user="bob")

    async def test_kick_allows_rejoin_ban_does_not(self):
        star = await self.star_with_roles()
        alice, bob = self.users["alice"].id, self.users["bob"].id

        await self.call(api.kick_member, star.id, alice, user="mod")
        self.assertIn((alice, {"type": "star_removed", "star_id": star.id, "reason": "kick"}), self.events)
        await self.join(star.id, "alice")

        # Модератор блокировать не может, админ — может.
        await self.expect_error(403, api.ban_member, star.id, bob, user="mod")
        await self.call(api.ban_member, star.id, bob, user="admin")
        invite = await self.call(api.create_invite, star.id, CreateInvite(), user="owner")
        await self.expect_error(403, api.join_by_invite, invite.code, user="bob")

        await self.call(api.unban, star.id, bob, user="admin")
        await self.call(api.join_by_invite, invite.code, user="bob")

    async def test_moderator_cannot_kick_admin(self):
        star = await self.star_with_roles()
        await self.expect_error(403, api.kick_member, star.id, self.users["admin"].id, user="mod")

    async def test_owner_can_revoke_moderator_kick(self):
        star = await self.star_with_roles()
        await self.call(
            api.update_permissions, star.id, UpdateRolePermissions(moderator=["invite"], member=[]), user="owner"
        )
        await self.expect_error(403, api.kick_member, star.id, self.users["alice"].id, user="mod")
        # Участники потеряли право приглашать.
        await self.expect_error(403, api.create_invite, star.id, CreateInvite(), user="alice")
        # Права настраивает только владелец.
        await self.expect_error(
            403, api.update_permissions, star.id, UpdateRolePermissions(moderator=[], member=[]), user="admin"
        )

    async def test_admin_cannot_appoint_admins(self):
        star = await self.star_with_roles()
        alice = self.users["alice"].id
        await self.expect_error(403, api.update_member_role, star.id, alice, UpdateMemberRole(role="admin"), user="admin")
        await self.call(api.update_member_role, star.id, alice, UpdateMemberRole(role="moderator"), user="admin")

    # --- Каналы ---

    async def test_gaming_channel_limits(self):
        star = await self.make_star("gaming")
        for i in range(2):
            await self.call(api.create_channel, star.id, CreateChannel(kind="satellite", name=f"s{i}"), user="owner")
        await self.expect_error(409, api.create_channel, star.id, CreateChannel(kind="satellite", name="лишний"), user="owner")
        for i in range(4):
            await self.call(api.create_channel, star.id, CreateChannel(kind="planet", name=f"p{i}"), user="owner")
        await self.expect_error(409, api.create_channel, star.id, CreateChannel(kind="planet", name="лишняя"), user="owner")

    async def test_work_star_has_no_channel_limits(self):
        star = await self.make_star("work")
        for i in range(8):
            await self.call(
                api.create_channel, star.id, CreateChannel(kind="planet", name=f"room{i}", room_kind="kitchen"), user="owner"
            )
        detail = await self.call(api.get_star, star.id, user="owner")
        kitchens = [c for c in detail.channels if c.room_kind == "kitchen"]
        self.assertEqual(len(kitchens), 8)
        self.assertTrue(all(c.capacity == 6 for c in kitchens))

    async def test_planet_capacity_cap(self):
        with self.assertRaises(ValidationError):
            CreateChannel(kind="planet", name="огромная", capacity=rules.PLANET_MAX_CAPACITY + 1)

    async def test_members_cannot_manage_channels(self):
        star = await self.star_with_roles()
        await self.expect_error(403, api.create_channel, star.id, CreateChannel(kind="satellite", name="x"), user="alice")
        await self.expect_error(403, api.create_channel, star.id, CreateChannel(kind="satellite", name="x"), user="mod")

    # --- Сообщения Спутников ---

    async def test_messages_and_deletion_rights(self):
        star = await self.star_with_roles()
        satellite = next(c for c in star.channels if c.kind == "satellite")
        planet = next(c for c in star.channels if c.kind == "planet")

        first = await self.call(api.send_message, star.id, satellite.id, SendStarMessage(text="привет"), user="alice")
        second = await self.call(api.send_message, star.id, satellite.id, SendStarMessage(text="и тебе"), user="bob")
        history = await self.call(api.list_messages, star.id, satellite.id, user="owner", limit=50, before_id=None)
        self.assertEqual([m.text for m in history], ["привет", "и тебе"])
        self.assertEqual(history[0].sender.username, "alice")

        await self.expect_error(403, api.delete_message, star.id, satellite.id, second.id, user="alice")
        await self.call(api.delete_message, star.id, satellite.id, first.id, user="alice")
        await self.call(api.delete_message, star.id, satellite.id, second.id, user="mod")

        await self.expect_error(400, api.send_message, star.id, planet.id, SendStarMessage(text="x"), user="alice")
        await self.expect_error(404, api.send_message, star.id, satellite.id, SendStarMessage(text="x"), user="carol")

    async def test_messages_reach_all_members(self):
        star = await self.star_with_roles()
        satellite = next(c for c in star.channels if c.kind == "satellite")
        self.events.clear()
        await self.call(api.send_message, star.id, satellite.id, SendStarMessage(text="всем"), user="alice")
        recipients = {uid for uid, e in self.events if e["type"] == "star_message"}
        expected = {self.users[n].id for n in ("owner", "admin", "mod", "alice", "bob")}
        self.assertEqual(recipients, expected)


if __name__ == "__main__":
    unittest.main()

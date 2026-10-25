"""Общая основа тестов Созвездия на настоящей PostgreSQL.

База берётся из TEST_DATABASE_URL (по умолчанию — локальная dev-база), но все таблицы
создаются в отдельной схеме quazar_test, которая пересоздаётся перед каждым тестом.
Если база недоступна, тесты пропускаются.
"""

import os
import unittest
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import stars as api
from app.core import presence, voice
from app.core.database import Base
from app.models.user import User
from app.schemas.star import CreateInvite, CreateStar, UpdateMemberRole

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://quazar:quazar@localhost:5432/quazar"
)
SCHEMA = "quazar_test"


class StarsTestBase(unittest.IsolatedAsyncioTestCase):
    """Схема quazar_test в PostgreSQL, шесть пользователей, перехват рассылки по WebSocket."""

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
        # Реестр голоса ходит в БД сам — направляем его в тестовую схему.
        session_patch = mock.patch.object(voice, "session_factory", self.Session)
        session_patch.start()
        self.addCleanup(session_patch.stop)
        # И реестр «кто в сети» (статусы, «не беспокоить»).
        presence_patch = mock.patch.object(presence, "session_factory", self.Session)
        presence_patch.start()
        self.addCleanup(presence_patch.stop)
        voice.reset()
        self.addCleanup(voice.reset)

        # Перехватываем рассылку по WebSocket.
        self.events: list[tuple[str, dict]] = []

        async def broadcast(user_ids, event, exclude_user=None):
            for uid in user_ids:
                if uid != exclude_user:
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

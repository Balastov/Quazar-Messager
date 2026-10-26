"""Владелец ресурса («Чёрная дыра»): скрытость, роль, блокировка, власть в любой Звезде, лимиты.

Нужна PostgreSQL (TEST_DATABASE_URL); без базы тесты пропускаются.
"""

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import update

from app.api import admin
from app.api import auth as auth_api
from app.api import moderation as moderation_api
from app.api import stars as api
from app.core import deps
from app.core.security import create_access_token, hash_password
from app.core.stars import MAX_OWNED_STARS
from app.models.user import User
from app.schemas.star import CreateChannel, CreateStar, SendStarMessage
from app.schemas.user import UserLogin
from tests.stars_base import StarsTestBase


class AdminTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.Session() as db:
            await db.execute(update(User).where(User.username == "carol").values(is_superuser=True))
            await db.commit()
            for name in self.users:
                self.users[name] = await db.get(User, self.users[name].id)

    def uid(self, name: str) -> str:
        return self.users[name].id

    async def sup(self, fn, *args, user: str = "carol", **kwargs):
        """Вызов раздела «Чёрная дыра» от имени владельца ресурса."""
        async with self.Session() as db:
            me = await db.get(User, self.uid(user))
            return await fn(*args, me=me, db=db, **kwargs)

    async def superuser_of(self, token: str | None):
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token) if token else None
        async with self.Session() as db:
            return await deps.get_superuser(creds, db)

    async def test_hidden_from_everyone_else(self):
        for token in (None, "garbage", create_access_token(self.uid("alice"))):
            with self.assertRaises(HTTPException) as ctx:
                await self.superuser_of(token)
            # Ровно как несуществующий адрес.
            self.assertEqual((ctx.exception.status_code, ctx.exception.detail), (404, "Not Found"))
        me = await self.superuser_of(create_access_token(self.uid("carol")))
        self.assertEqual(me.username, "carol")
        # В обычных ответах о людях признака роли нет.
        from app.schemas.user import UserOut
        self.assertNotIn("is_superuser", UserOut.model_fields)

    async def test_grant_revoke_and_last_owner(self):
        out = await self.sup(admin.grant_superuser, self.uid("alice"))
        self.assertTrue(out.is_superuser)
        await self.sup(admin.revoke_superuser, self.uid("carol"), user="alice")
        with self.assertRaises(HTTPException) as ctx:  # последний
            await self.sup(admin.revoke_superuser, self.uid("alice"), user="alice")
        self.assertEqual(ctx.exception.status_code, 400)
        listed = await self.sup(admin.list_users, user="alice", q="", filter="superusers", before=None, limit=50)
        self.assertEqual([u.username for u in listed], ["alice"])

    async def test_block_account(self):
        async with self.Session() as db:
            await db.execute(update(User).where(User.username == "bob").values(password_hash=hash_password("secret-pass")))
            await db.commit()
        with self.assertRaises(HTTPException):
            await self.sup(admin.block_user, self.uid("carol"), admin.BlockBody())
        out = await self.sup(admin.block_user, self.uid("bob"), admin.BlockBody(reason="  спам  рассылки "))
        self.assertEqual(out.blocked_reason, "спам рассылки")
        async with self.Session() as db:
            with self.assertRaises(HTTPException) as ctx:
                await auth_api.login(UserLogin(phone=self.users["bob"].phone, password="secret-pass"), db)
            self.assertEqual(ctx.exception.status_code, 403)
            creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=create_access_token(self.uid("bob")))
            with self.assertRaises(HTTPException) as ctx:
                await deps.get_current_user(creds, db)
            self.assertEqual(ctx.exception.status_code, 401)
        await self.sup(admin.unblock_user, self.uid("bob"))
        async with self.Session() as db:
            token = await auth_api.login(UserLogin(phone=self.users["bob"].phone, password="secret-pass"), db)
        self.assertTrue(token.access_token)

    async def test_power_in_any_star_and_no_limits(self):
        star = await self.star_with_roles()  # carol там не участник
        sat = next(c for c in star.channels if c.kind == "satellite")
        msg = await self.call(api.send_message, star.id, sat.id, SendStarMessage(text="спам"), user="alice")
        detail = await self.call(api.get_star, star.id, user="carol")
        self.assertEqual(detail.my_role, "owner")
        self.assertNotIn(self.uid("carol"), [m.user.id for m in detail.members])  # её там как бы нет
        await self.call(api.delete_message, star.id, sat.id, msg.id, user="carol")
        # Лимиты: каналы игровой Звезды и число своих Звёзд.
        for i in range(6):
            await self.call(api.create_channel, star.id, CreateChannel(kind="planet", name=f"П{i}"), user="carol")
        for i in range(MAX_OWNED_STARS + 1):
            await self.call(api.create_star, CreateStar(name=f"Моя {i}", kind="work"), user="carol")
        stars = await self.sup(admin.list_stars, q="", limit=100)
        self.assertEqual(len(stars), MAX_OWNED_STARS + 2)

    async def test_reports(self):
        await self.call(
            moderation_api.report_user, self.uid("bob"),
            moderation_api.ReportBody(reason="spam", comment="рассылает ссылки"), user="alice",
        )
        reports = await self.sup(admin.list_reports, status_filter="open", limit=100)
        self.assertEqual((reports[0].target.username, reports[0].comment), ("bob", "рассылает ссылки"))
        await self.sup(admin.resolve_report, reports[0].id)
        self.assertEqual(await self.sup(admin.list_reports, status_filter="open", limit=100), [])
        stats = await self.sup(admin.admin_me)
        self.assertEqual((stats.users, stats.open_reports), (6, 0))

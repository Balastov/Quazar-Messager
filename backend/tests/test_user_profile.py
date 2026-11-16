"""Профиль другого человека: GET /users/{id} — те же поля, что в поиске."""

from app.api import users as api
from app.models.user import User
from app.schemas.user import UserOut
from tests.stars_base import StarsTestBase


class TestUserProfile(StarsTestBase):
    async def profile(self, name: str, viewer: str = "alice") -> UserOut:
        return UserOut.model_validate(await self.call(api.get_user, self.users[name].id, user=viewer))

    async def test_shows_public_fields_and_phone_only_when_findable(self):
        async with self.Session() as db:
            bob = await db.get(User, self.users["bob"].id)
            bob.first_name, bob.last_name, bob.phone_discoverable = "Боб", "Петров", True
            await db.commit()
        out = await self.profile("bob")
        self.assertEqual((out.username, out.display_name), (self.users["bob"].username, "Боб Петров"))
        self.assertEqual(out.phone, self.users["bob"].phone)

        async with self.Session() as db:
            (await db.get(User, self.users["bob"].id)).phone_discoverable = False
            await db.commit()
        self.assertIsNone((await self.profile("bob")).phone)
        self.assertNotIn("email", UserOut.model_fields)

    async def test_unknown_and_deactivated_users_are_not_found(self):
        await self.expect_error(404, api.get_user, "00000000-0000-0000-0000-000000000000", user="alice")
        async with self.Session() as db:
            (await db.get(User, self.users["carol"].id)).is_active = False
            await db.commit()
        await self.expect_error(404, api.get_user, self.users["carol"].id, user="alice")

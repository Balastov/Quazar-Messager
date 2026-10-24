"""Фоны: личный фон приложения и фон Звезды (только владелец и админы)."""

import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import UploadFile

from app.api import stars as api
from app.api import users as users_api
from app.core.backgrounds import MAX_BACKGROUND_BYTES
from app.core.config import settings
from tests.stars_base import StarsTestBase

JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 64


def upload(data: bytes = JPEG) -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename="bg.jpg")


class BackgroundsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, True)
        patcher = mock.patch.object(settings, "MEDIA_ROOT", self.media)
        patcher.start()
        self.addCleanup(patcher.stop)

    def stored(self) -> list[str]:
        directory = Path(self.media) / "backgrounds"
        return sorted(p.name for p in directory.iterdir()) if directory.exists() else []

    def file_of(self, url: str) -> str:
        self.assertRegex(url, r"^/media/backgrounds/[0-9a-f]{32}\.jpg$")
        return url.rsplit("/", 1)[1]

    # --- личный фон ---

    async def test_personal_background_reaches_only_own_devices(self):
        self.events.clear()
        out = await self.call(users_api.upload_my_background, file=upload(), user="alice")
        self.assertEqual(self.stored(), [self.file_of(out.background_url)])
        self.assertEqual(
            self.events,
            [(self.users["alice"].id, {"type": "user_background", "background_url": out.background_url})],
        )
        got = await users_api.get_my_background(current_user=self.users["alice"])
        self.assertEqual(got.background_url, out.background_url)

    async def test_replacing_and_removing_personal_background_cleans_files(self):
        first = await self.call(users_api.upload_my_background, file=upload(), user="alice")
        second = await self.call(users_api.upload_my_background, file=upload(), user="alice")
        self.assertNotEqual(first.background_url, second.background_url)
        self.assertEqual(self.stored(), [self.file_of(second.background_url)])

        out = await self.call(users_api.remove_my_background, user="alice")
        self.assertIsNone(out.background_url)
        self.assertEqual(self.stored(), [])

    async def test_personal_background_rejects_non_images_and_big_files(self):
        await self.expect_error(422, users_api.upload_my_background, file=upload(b"<html>" * 20), user="alice")
        big = JPEG + b"\0" * MAX_BACKGROUND_BYTES
        await self.expect_error(413, users_api.upload_my_background, file=upload(big), user="alice")
        self.assertEqual(self.stored(), [])

    # --- фон Звезды ---

    async def test_owner_and_admin_set_star_background_for_everyone(self):
        star = await self.star_with_roles()
        self.events.clear()
        detail = await self.call(api.upload_star_background, star.id, file=upload(), user="admin")
        self.file_of(detail.background_url)

        update = [e for uid, e in self.events if uid == self.users["bob"].id and e["type"] == "star_updated"]
        self.assertEqual(update[-1]["background_url"], detail.background_url)
        listed = await self.call(api.list_stars, user="alice")
        self.assertEqual(listed[0].background_url, detail.background_url)

        detail = await self.call(api.upload_star_background, star.id, file=upload(), user="owner")
        self.assertEqual(self.stored(), [self.file_of(detail.background_url)])

    async def test_moderator_and_member_cannot_touch_star_background(self):
        star = await self.star_with_roles()
        for user in ("mod", "alice"):
            await self.expect_error(403, api.upload_star_background, star.id, file=upload(), user=user)
            await self.expect_error(403, api.remove_star_background, star.id, user=user)
        self.assertEqual(self.stored(), [])

    async def test_star_background_removed_with_star(self):
        star = await self.make_star()
        await self.call(api.upload_star_background, star.id, file=upload(), user="owner")
        detail = await self.call(api.remove_star_background, star.id, user="owner")
        self.assertIsNone(detail.background_url)
        self.assertEqual(self.stored(), [])

        await self.call(api.upload_star_background, star.id, file=upload(), user="owner")
        await self.call(api.delete_star, star.id, user="owner")
        self.assertEqual(self.stored(), [])


if __name__ == "__main__":
    unittest.main()

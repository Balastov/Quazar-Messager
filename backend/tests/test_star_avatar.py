"""Аватар Звезды: ставят и убирают только владелец и админы, файл живёт в /media/avatars/stars."""

import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import UploadFile

from app.api import stars as api
from app.core.avatars import MAX_AVATAR_BYTES
from app.core.config import settings
from app.schemas.star import CreateInvite
from tests.stars_base import StarsTestBase

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


def upload(data: bytes = PNG, name: str = "star.png") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name)


class StarAvatarTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, True)
        patcher = mock.patch.object(settings, "MEDIA_ROOT", self.media)
        patcher.start()
        self.addCleanup(patcher.stop)

    def stored(self) -> list[str]:
        directory = Path(self.media) / "avatars" / "stars"
        return sorted(p.name for p in directory.iterdir()) if directory.exists() else []

    async def test_owner_sets_avatar_and_members_see_it(self):
        star = await self.star_with_roles()
        self.events.clear()

        detail = await self.call(api.upload_star_avatar, star.id, file=upload(), user="owner")

        self.assertRegex(detail.avatar_url, rf"^/media/avatars/stars/{star.id}\.png\?v=\d+$")
        self.assertEqual(self.stored(), [f"{star.id}.png"])
        updates = [e for uid, e in self.events if e["type"] == "star_updated" and uid == self.users["bob"].id]
        self.assertEqual(updates[-1]["avatar_url"], detail.avatar_url)
        # Видно в списке Звёзд и в приглашении.
        listed = await self.call(api.list_stars, user="alice")
        self.assertEqual(listed[0].avatar_url, detail.avatar_url)
        invite = await self.call(api.create_invite, star.id, CreateInvite(), user="owner")
        preview = await self.call(api.preview_invite, invite.code, user="carol")
        self.assertEqual(preview.star_avatar_url, detail.avatar_url)

    async def test_admin_can_change_avatar_moderator_and_member_cannot(self):
        star = await self.star_with_roles()
        detail = await self.call(api.upload_star_avatar, star.id, file=upload(), user="admin")
        self.assertIsNotNone(detail.avatar_url)
        for user in ("mod", "alice"):
            await self.expect_error(403, api.upload_star_avatar, star.id, file=upload(), user=user)
            await self.expect_error(403, api.remove_star_avatar, star.id, user=user)
        await self.expect_error(404, api.upload_star_avatar, star.id, file=upload(), user="carol")

    async def test_replacing_avatar_keeps_one_file_and_new_version(self):
        star = await self.make_star()
        first = await self.call(api.upload_star_avatar, star.id, file=upload(), user="owner")
        gif = b"GIF89a" + b"\0" * 64
        with mock.patch("app.core.avatars.time.time", return_value=9_999_999_999):
            second = await self.call(api.upload_star_avatar, star.id, file=upload(gif, "a.gif"), user="owner")
        self.assertNotEqual(first.avatar_url, second.avatar_url)
        self.assertEqual(self.stored(), [f"{star.id}.gif"])

    async def test_rejects_non_images_and_big_files(self):
        star = await self.make_star()
        await self.expect_error(422, api.upload_star_avatar, star.id, file=upload(b"<svg></svg>" * 10), user="owner")
        too_big = PNG + b"\0" * MAX_AVATAR_BYTES
        await self.expect_error(413, api.upload_star_avatar, star.id, file=upload(too_big), user="owner")
        self.assertEqual(self.stored(), [])

    async def test_remove_avatar_and_star_deletion_clean_up_files(self):
        star = await self.make_star()
        await self.call(api.upload_star_avatar, star.id, file=upload(), user="owner")
        detail = await self.call(api.remove_star_avatar, star.id, user="owner")
        self.assertIsNone(detail.avatar_url)
        self.assertEqual(self.stored(), [])

        await self.call(api.upload_star_avatar, star.id, file=upload(), user="owner")
        await self.call(api.delete_star, star.id, user="owner")
        self.assertEqual(self.stored(), [])


if __name__ == "__main__":
    unittest.main()

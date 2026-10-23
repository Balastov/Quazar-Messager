"""Картинки в чатах: загрузка, лимит 10 МБ, доступ только участникам, привязка к сообщению, уборка.

Нужна PostgreSQL (TEST_DATABASE_URL); таблицы — в схеме quazar_test. Без базы тесты пропускаются.
"""

import os
import shutil
import tempfile
import unittest
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import attachments as api
from app.api import messages as messages_api
from app.core import attachments
from app.core.config import settings
from app.core.database import Base
from app.models.attachment import Attachment
from app.models.chat import Chat, ChatMember
from app.models.user import User
from app.schemas.message import SendMessage

DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://quazar:quazar@localhost:5432/quazar"
)
SCHEMA = "quazar_test"
MB = 1024 * 1024


class FakeRequest:
    """Минимум от starlette Request, который читает эндпоинт загрузки."""

    def __init__(self, body: bytes, chunk: int = 64 * 1024, declare_length: bool = True):
        self.body = body
        self.chunk = chunk
        self.headers = {"content-length": str(len(body))} if declare_length else {}

    async def stream(self):
        for i in range(0, len(self.body), self.chunk):
            yield self.body[i : i + self.chunk]


class AttachmentsTest(unittest.IsolatedAsyncioTestCase):
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

        async def broadcast(user_ids, event, exclude_user=None):
            pass

        patcher = mock.patch.object(messages_api.manager, "broadcast_to_users", broadcast)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.users: dict[str, User] = {}
        async with self.Session() as db:
            for i, name in enumerate(["alice", "bob", "eve"]):
                self.users[name] = User(username=name, phone=f"+7900000001{i}", password_hash="x")
                db.add(self.users[name])
            self.chat = Chat(type="direct")
            db.add(self.chat)
            await db.flush()
            for name in ("alice", "bob"):
                db.add(ChatMember(chat_id=self.chat.id, user_id=self.users[name].id))
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

    async def expect_error(self, status_code: int, fn, *args, user: str, **kwargs):
        with self.assertRaises(HTTPException) as ctx:
            await self.call(fn, *args, user=user, **kwargs)
        self.assertEqual(ctx.exception.status_code, status_code, ctx.exception.detail)

    async def upload(self, body: bytes, user="alice", **kwargs):
        return await self.call(
            api.upload_attachment, self.chat.id, request=FakeRequest(body, **kwargs), user=user
        )

    def stored_files(self) -> list[str]:
        return sorted(p.name for p in (Path(self.media) / "attachments").iterdir())

    # --- tests ---

    async def test_member_uploads_and_peer_downloads(self):
        body = os.urandom(5000)
        out = await self.upload(body)
        self.assertEqual(out.size, 5000)

        resp = await self.call(api.download_attachment, self.chat.id, out.id, user="bob")
        self.assertEqual(Path(resp.path).read_bytes(), body)
        self.assertEqual(resp.media_type, "application/octet-stream")
        # Кеш на устройстве — не дольше срока хранения на сервере (30 дней).
        self.assertIn("max-age=2592000", resp.headers["cache-control"])

    async def test_outsider_cannot_upload_or_download(self):
        out = await self.upload(os.urandom(100))
        await self.expect_error(403, api.download_attachment, self.chat.id, out.id, user="eve")
        await self.expect_error(
            403, api.upload_attachment, self.chat.id, request=FakeRequest(os.urandom(100)), user="eve"
        )

    async def test_ten_megabytes_plus_encryption_overhead_is_allowed(self):
        out = await self.upload(b"\0" * attachments.MAX_ATTACHMENT_BYTES, chunk=MB)
        self.assertEqual(out.size, 10 * MB + 40)

    async def test_bigger_than_ten_megabytes_is_rejected_without_leftovers(self):
        too_big = b"\0" * (attachments.MAX_ATTACHMENT_BYTES + 1)
        # Заявленная длина отсекает сразу, а без неё — обрыв потока на лимите.
        await self.expect_error(
            413, api.upload_attachment, self.chat.id, request=FakeRequest(too_big), user="alice"
        )
        await self.expect_error(
            413,
            api.upload_attachment,
            self.chat.id,
            request=FakeRequest(too_big, chunk=MB, declare_length=False),
            user="alice",
        )
        self.assertEqual(self.stored_files(), [])
        async with self.Session() as db:
            self.assertEqual((await db.execute(select(Attachment))).scalars().all(), [])

    async def test_empty_upload_is_rejected(self):
        await self.expect_error(
            422, api.upload_attachment, self.chat.id, request=FakeRequest(b"x" * 40), user="alice"
        )
        self.assertEqual(self.stored_files(), [])

    async def test_upload_refused_when_disk_is_almost_full(self):
        usage = namedtuple("usage", "total used free")
        with mock.patch.object(settings, "MEDIA_MIN_FREE_MB", 2048), mock.patch.object(
            attachments.shutil, "disk_usage", return_value=usage(100 * 1024 * MB, 0, 1024 * MB)
        ):
            await self.expect_error(
                507, api.upload_attachment, self.chat.id, request=FakeRequest(b"x" * 100), user="alice"
            )

    async def test_message_links_own_unsent_attachment_once(self):
        out = await self.upload(os.urandom(100))
        msg = await self.call(
            messages_api.send_message,
            self.chat.id,
            SendMessage(payload="ENC2:...", attachment_id=out.id),
            user="alice",
        )
        async with self.Session() as db:
            self.assertEqual((await db.get(Attachment, out.id)).message_id, msg.id)

        # Повторно то же вложение к другому сообщению не прикрепить.
        await self.expect_error(
            422,
            messages_api.send_message,
            self.chat.id,
            SendMessage(payload="ENC2:...", attachment_id=out.id),
            user="alice",
        )

    async def test_cannot_attach_someone_elses_upload(self):
        out = await self.upload(os.urandom(100), user="bob")
        await self.expect_error(
            422,
            messages_api.send_message,
            self.chat.id,
            SendMessage(payload="x", attachment_id=out.id),
            user="alice",
        )

    async def test_sweep_removes_unsent_and_orphaned_files_only(self):
        sent = await self.upload(os.urandom(100))
        await self.call(
            messages_api.send_message,
            self.chat.id,
            SendMessage(payload="x", attachment_id=sent.id),
            user="alice",
        )
        fresh = await self.upload(os.urandom(100))
        stale = await self.upload(os.urandom(100))
        async with self.Session() as db:
            await db.execute(
                update(Attachment)
                .where(Attachment.id == stale.id)
                .values(created_at=datetime.now(timezone.utc) - timedelta(days=2))
            )
            await db.commit()
        # Файл без строки в БД (например, чат удалили каскадом), давно лежащий.
        orphan = attachments.attachment_path("00000000-0000-0000-0000-000000000000")
        orphan.write_bytes(b"x")
        old = (datetime.now() - timedelta(hours=2)).timestamp()
        os.utime(orphan, (old, old))

        async with self.Session() as db:
            await attachments.sweep(db)

        self.assertEqual(self.stored_files(), sorted([sent.id, fresh.id]))
        async with self.Session() as db:
            ids = set((await db.execute(select(Attachment.id))).scalars().all())
        self.assertEqual(ids, {sent.id, fresh.id})

    async def _sent_attachment_aged(self, days: float) -> str:
        out = await self.upload(os.urandom(100))
        await self.call(
            messages_api.send_message,
            self.chat.id,
            SendMessage(payload="x", attachment_id=out.id),
            user="alice",
        )
        async with self.Session() as db:
            await db.execute(
                update(Attachment)
                .where(Attachment.id == out.id)
                .values(created_at=datetime.now(timezone.utc) - timedelta(days=days))
            )
            await db.commit()
        return out.id

    async def test_sent_images_are_deleted_after_thirty_days(self):
        old = await self._sent_attachment_aged(31)
        young = await self._sent_attachment_aged(29)

        async with self.Session() as db:
            await attachments.sweep(db)

        self.assertEqual(self.stored_files(), [young])
        # Сообщение остаётся, картинка по нему отдаёт 404.
        await self.expect_error(404, api.download_attachment, self.chat.id, old, user="bob")
        resp = await self.call(api.download_attachment, self.chat.id, young, user="bob")
        self.assertTrue(Path(resp.path).is_file())

    async def test_ttl_zero_keeps_images_forever(self):
        old = await self._sent_attachment_aged(400)
        with mock.patch.object(settings, "ATTACHMENT_TTL_DAYS", 0):
            async with self.Session() as db:
                await attachments.sweep(db)
        self.assertEqual(self.stored_files(), [old])

    def test_attachment_path_rejects_traversal(self):
        with self.assertRaises(ValueError):
            attachments.attachment_path("../avatars/x")


if __name__ == "__main__":
    unittest.main()

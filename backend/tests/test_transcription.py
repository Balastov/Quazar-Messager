import asyncio
import base64
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import select, update

from app.api import transcription as api
from app.core import transcription as asr
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.attachment import Attachment
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.transcription import TranscriptionUsage
from app.models.user import User
from tests.stars_base import StarsTestBase


class ProviderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patcher = mock.patch.multiple(settings, CLOUDFLARE_ACCOUNT_ID="a" * 32,
                                     CLOUDFLARE_API_TOKEN="private-secret",
                                     CLOUDFLARE_ASR_MODEL="@cf/openai/whisper-large-v3-turbo")
        patcher.start(); self.addCleanup(patcher.stop)

    async def test_russian_audio_and_no_key_or_translation(self):
        def handler(request):
            body = json.loads(request.content)
            self.assertEqual(base64.b64decode(body["audio"]), b"FLAC")
            self.assertEqual((body["language"], body["task"], body["vad_filter"]), ("ru", "transcribe", True))
            self.assertNotIn("key", body)
            self.assertEqual(request.headers["authorization"], "Bearer private-secret")
            return httpx.Response(200, json={"success": True, "result": {"text": " Привет! "}})
        self.assertEqual(await asr.transcribe(b"FLAC", transport=httpx.MockTransport(handler)), "Привет!")

    async def test_provider_errors_do_not_expose_response_or_token(self):
        for status, body, expected in (
            (429, {}, 429), (403, {"errors": ["private-secret"]}, 502),
            (200, {"success": False, "errors": ["private-secret"]}, 502),
            (200, {"success": True, "result": {}}, 502),
        ):
            with self.assertRaises(HTTPException) as raised:
                await asr.transcribe(b"x", transport=httpx.MockTransport(lambda _: httpx.Response(status, json=body)))
            self.assertEqual(raised.exception.status_code, expected)
            self.assertNotIn("private-secret", raised.exception.detail)

    async def test_timeout_and_empty_speech(self):
        def timeout(request):
            raise httpx.ReadTimeout("private-secret", request=request)
        with self.assertRaises(HTTPException) as raised:
            await asr.transcribe(b"x", transport=httpx.MockTransport(timeout))
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(await asr.transcribe(b"x", transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"success": True, "result": {"text": ""}}))), "")

    def test_limits_and_non_audio_never_start_decoder(self):
        with mock.patch.object(asr.subprocess, "run") as run:
            for data in (b"", b"x" * (asr.MAX_BYTES + 1), b"#EXTM3U\nfile:///etc/passwd"):
                with self.assertRaises(HTTPException): asr.prepare_audio(data)
            run.assert_not_called()

    def test_duration_is_measured_and_temporary_files_removed(self):
        folders = []
        def run(args, **kwargs):
            if args[0] == "ffmpeg":
                target = Path(args[-1]); target.write_bytes(b"FLAC"); folders.append(target.parent)
                self.assertEqual(args[args.index("-t") + 1], "601")
                self.assertIn("matroska", args)
                return SimpleNamespace(stdout=b"")
            return SimpleNamespace(stdout=b"12.01\n")
        with mock.patch.object(asr.subprocess, "run", side_effect=run):
            self.assertEqual(asr.prepare_audio(b"\x1a\x45\xdf\xa3" + b"x" * 20), (b"FLAC", 13))
        self.assertTrue(folders)
        self.assertTrue(all(not folder.exists() for folder in folders))

    def test_overlong_and_invalid_duration_rejected(self):
        for duration in (b"601", b"nan", b"0", b"N/A"):
            def run(args, **kwargs):
                if args[0] == "ffmpeg": Path(args[-1]).write_bytes(b"FLAC")
                return SimpleNamespace(stdout=duration)
            with mock.patch.object(asr.subprocess, "run", side_effect=run):
                with self.assertRaises(HTTPException): asr.prepare_audio(b"OggS" + b"x" * 20)


class TranscriptionTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        patcher = mock.patch.multiple(settings, CLOUDFLARE_ACCOUNT_ID="a" * 32,
            CLOUDFLARE_API_TOKEN="private-secret", TRANSCRIPTION_USER_MINUTES_PER_DAY=1,
            TRANSCRIPTION_TOTAL_MINUTES_PER_DAY=2)
        patcher.start(); self.addCleanup(patcher.stop)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        patcher = mock.patch.object(settings, "MEDIA_ROOT", self.temp.name)
        patcher.start(); self.addCleanup(patcher.stop)
        self.prepare = mock.Mock(return_value=(b"FLAC", 40))
        self.provider = mock.AsyncMock(return_value="Привет")
        for name, value in (("prepare_audio", self.prepare), ("transcribe", self.provider)):
            patcher = mock.patch.object(asr, name, value); patcher.start(); self.addCleanup(patcher.stop)
        async with self.Session() as db:
            self.chat = Chat(type="direct"); db.add(self.chat); await db.flush()
            db.add(ChatMember(chat_id=self.chat.id, user_id=self.users["alice"].id))
            self.message = Message(chat_id=self.chat.id, sender_id=self.users["alice"].id,
                                   payload="encrypted")
            db.add(self.message); await db.flush()
            self.attachment = Attachment(chat_id=self.chat.id, uploader_id=self.users["alice"].id,
                                         message_id=self.message.id, size=100)
            db.add(self.attachment); await db.commit()
        from app.core.attachments import attachment_path
        path = attachment_path(self.attachment.id); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"ciphertext")
        self.app = FastAPI(); self.app.include_router(api.router)
        async def database():
            async with self.Session() as db: yield db
        self.app.dependency_overrides[get_db] = database
        self.app.dependency_overrides[get_current_user] = lambda: self.users["alice"]
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def post(self, **kwargs):
        return await self.client.post(f"/chats/{self.chat.id}/attachments/{self.attachment.id}/transcribe",
            content=b"raw audio", headers={"X-Transcription-Consent": "cloudflare"}, **kwargs)

    async def test_consent_member_and_size_checked_before_provider(self):
        url = f"/chats/{self.chat.id}/attachments/{self.attachment.id}/transcribe"
        self.assertEqual((await self.client.post(url, content=b"audio")).status_code, 422)
        self.app.dependency_overrides[get_current_user] = lambda: self.users["bob"]
        self.assertEqual((await self.post()).status_code, 403)
        self.app.dependency_overrides[get_current_user] = lambda: self.users["alice"]
        with mock.patch.object(asr, "MAX_BYTES", 3):
            self.assertEqual((await self.post()).status_code, 413)
        self.provider.assert_not_awaited(); self.prepare.assert_not_called()

    async def test_text_not_stored_and_quota_survives_new_session(self):
        response = await self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"text": "Привет"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual((await self.post()).status_code, 429)
        self.provider.assert_awaited_once()
        async with self.Session() as db:
            rows = (await db.execute(select(TranscriptionUsage))).scalars().all()
            self.assertEqual(sorted((r.seconds, r.requests) for r in rows), [(40, 1), (40, 1)])

    async def test_total_quota_is_atomic_under_concurrency(self):
        async def reserve(who):
            async with self.Session() as db:
                try: await asr.reserve_usage(db, who, 50); return True
                except HTTPException: return False
        self.assertEqual(sum(await asyncio.gather(*(reserve(str(i)) for i in range(5)))), 2)
        async with self.Session() as db:
            total = await db.get(TranscriptionUsage, (datetime.now(timezone.utc).date(), "total"))
            self.assertEqual((total.seconds, total.requests), (100, 2))

    async def test_disabled_and_deleted_attachment(self):
        with mock.patch.object(settings, "CLOUDFLARE_API_TOKEN", ""):
            self.assertFalse((await self.client.get("/transcription/status")).json()["enabled"])
            self.assertEqual((await self.post()).status_code, 503)
        from app.core.attachments import attachment_path
        attachment_path(self.attachment.id).unlink()
        self.assertEqual((await self.post()).status_code, 404)
        self.provider.assert_not_awaited()

    async def test_regular_user_has_exactly_100_minutes_and_failed_reservation_is_atomic(self):
        with mock.patch.multiple(settings, TRANSCRIPTION_USER_MINUTES_PER_DAY=100,
                                 TRANSCRIPTION_TOTAL_MINUTES_PER_DAY=180):
            async with self.Session() as db:
                await asr.reserve_usage(db, self.users["alice"].id, 6000)
            async with self.Session() as db:
                with self.assertRaises(HTTPException) as raised:
                    await asr.reserve_usage(db, self.users["alice"].id, 1)
                self.assertEqual(raised.exception.status_code, 429)
            async with self.Session() as db:
                rows = (await db.execute(select(TranscriptionUsage))).scalars().all()
                self.assertEqual(sorted(row.seconds for row in rows), [6000, 6000])

    async def test_superuser_bypasses_personal_total_and_request_limits_but_usage_is_counted(self):
        day = datetime.now(timezone.utc).date()
        async with self.Session() as db:
            await db.execute(update(User).where(User.id == self.users["alice"].id).values(is_superuser=True))
            for bucket in ("total", f"user:{self.users['alice'].id}"):
                db.add(TranscriptionUsage(day=day, bucket=bucket, seconds=10800, requests=1000))
            await db.commit()
        # В объекте из HTTP dependency по-прежнему старая роль: reserve_usage берёт её из БД.
        with mock.patch.multiple(settings, TRANSCRIPTION_USER_MINUTES_PER_DAY=0,
                                 TRANSCRIPTION_TOTAL_MINUTES_PER_DAY=0):
            for _ in range(2):
                response = await self.post()
                self.assertEqual(response.status_code, 200, response.text)
        async with self.Session() as db:
            rows = (await db.execute(select(TranscriptionUsage))).scalars().all()
            self.assertEqual([(row.seconds, row.requests) for row in rows], [(10880, 1002), (10880, 1002)])
            await db.execute(update(User).where(User.id == self.users["alice"].id).values(is_superuser=False))
            await db.commit()
        self.assertEqual((await self.post()).status_code, 429)

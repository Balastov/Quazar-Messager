import asyncio
import subprocess
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import select

from app.api import recording_transcription as api
from app.core import recording_transcription as service, recordings, star_files, transcription
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.recording import RoomRecording
from app.models.star import StarChannel, StarFile, StarMessage
from app.models.transcription import RecordingTranscript, TranscriptionUsage
from tests.stars_base import StarsTestBase


class AudioTest(unittest.TestCase):
    def test_decoded_duration_limits_and_small_flac_chunks(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / "source", Path(folder) / "output.flac"
            source.write_bytes(b"OggS" + b"x" * 20)
            def run(args, **kwargs):
                if args[0] == "ffmpeg":
                    target.write_bytes(b"FLAC")
                    self.assertIn("file,pipe", args)
                return SimpleNamespace(stdout=b"3600.01")
            with mock.patch.object(service.subprocess, "run", side_effect=run):
                self.assertEqual(service.normalize(source, target), 3601)
            def chunk(args, **kwargs):
                self.assertEqual(args[args.index("-ss") + 1], "300")
                self.assertEqual(args[args.index("-t") + 1], "300")
                target.write_bytes(b"fragment")
            with mock.patch.object(service.subprocess, "run", side_effect=chunk):
                self.assertEqual(service.audio_chunk(source, target, 300, 300), b"fragment")

    def test_playlists_overlong_and_corrupt_audio_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / "source", Path(folder) / "output.flac"
            source.write_bytes(b"#EXTM3U\nfile:///etc/passwd")
            with mock.patch.object(service.subprocess, "run") as run:
                with self.assertRaises(HTTPException): service.normalize(source, target)
                run.assert_not_called()
            source.write_bytes(b"OggS" + b"x" * 20)
            for duration in (b"14401", b"nan", b"0", b"N/A"):
                with mock.patch.object(service.subprocess, "run", return_value=SimpleNamespace(stdout=duration)):
                    with self.assertRaises(HTTPException): service.normalize(source, target)
            with mock.patch.object(service.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffmpeg", 180)):
                with self.assertRaises(HTTPException): service.normalize(source, target)


class RecordingTranscriptionTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.multiple(settings, MEDIA_ROOT=self.tmp.name, CLOUDFLARE_ACCOUNT_ID="a" * 32,
            CLOUDFLARE_API_TOKEN="private-secret", TRANSCRIPTION_USER_MINUTES_PER_DAY=30,
            TRANSCRIPTION_TOTAL_MINUTES_PER_DAY=180)
        patcher.start(); self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles("work")
        self.room = next(c for c in self.star.channels if c.kind == "planet" and c.room_kind != "meeting")
        async with self.Session() as db:
            self.rec = RoomRecording(star_id=self.star.id, channel_id=self.room.id,
                                     started_by=self.users["mod"].id, status="finished")
            db.add(self.rec); await db.flush()
            message = StarMessage(star_id=self.star.id, channel_id=self.room.id, sender_id=self.users["mod"].id,
                                  kind="recording", ref_id=self.rec.id, text="Запись встречи")
            db.add(message); await db.flush()
            self.rec.message_id = message.id
            db.add(StarFile(id=self.rec.audio_file_id, star_id=self.star.id, channel_id=self.room.id,
                uploader_id=self.users["mod"].id, message_id=message.id, name="Звук.webm", mime="audio/webm", size=20))
            await db.commit()
        source = star_files.file_path(self.rec.audio_file_id)
        source.parent.mkdir(parents=True, exist_ok=True); source.write_bytes(b"OggS" + b"x" * 16)
        self.normalize = mock.Mock(return_value=601)
        self.chunk = mock.Mock(side_effect=lambda _source, _target, start, seconds: f"{start}:{seconds}".encode())
        async def provider(data):
            await asyncio.sleep(0.01)
            return "Текст " + data.decode()
        self.provider = mock.AsyncMock(side_effect=provider)
        for obj, name, value in ((service, "normalize", self.normalize), (service, "audio_chunk", self.chunk),
                                 (transcription, "transcribe", self.provider)):
            patcher = mock.patch.object(obj, name, value); patcher.start(); self.addCleanup(patcher.stop)
        self.app = FastAPI(); self.app.include_router(api.router)
        async def database():
            async with self.Session() as db: yield db
        self.app.dependency_overrides[get_db] = database
        self.who = "alice"
        self.app.dependency_overrides[get_current_user] = lambda: self.users[self.who]
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)
        self.url = f"/stars/{self.star.id}/recordings/{self.rec.id}/transcription"

    async def start(self):
        return await self.client.post(self.url, headers={"X-Transcription-Consent": "cloudflare"})

    async def test_shared_saved_transcript_deduplicates_requests(self):
        self.assertEqual((await self.client.get(self.url)).json()["status"], "idle")
        self.assertEqual((await self.client.post(self.url)).status_code, 422)
        replies = await asyncio.gather(*(self.start() for _ in range(4)))
        self.assertTrue(all(r.status_code == 202 for r in replies))
        self.provider.assert_not_awaited()
        results = await asyncio.gather(service.run_next(self.Session), service.run_next(self.Session))
        self.assertEqual(sum(results), 1)
        self.assertEqual(self.provider.await_count, 3)
        self.normalize.assert_called_once()
        self.who = "bob"
        response = await self.client.get(self.url)
        self.assertEqual(response.headers["cache-control"], "no-store")
        saved = response.json()
        self.assertEqual((saved["status"], saved["processed_seconds"], saved["total_seconds"]), ("ready", 601, 601))
        self.assertIn("[00:05:00]", saved["text"])
        self.assertEqual((await self.start()).status_code, 200)
        self.assertFalse(await service.run_next(self.Session))
        self.assertEqual(self.provider.await_count, 3)

    async def test_budget_pause_and_resume_without_retranscribing_paid_parts(self):
        await self.start()
        with mock.patch.object(settings, "TRANSCRIPTION_USER_MINUTES_PER_DAY", 5):
            await service.run_next(self.Session)
        partial = (await self.client.get(self.url)).json()
        self.assertEqual((partial["status"], partial["processed_seconds"]), ("failed", 300))
        self.assertIn("лимит", partial["error"])
        self.assertIn("Текст 0:300", partial["text"])
        self.who = "bob"  # Продолживший расходует свои минуты; ранее полученный текст общий.
        await self.start(); await service.run_next(self.Session)
        done = (await self.client.get(self.url)).json()
        self.assertEqual(done["status"], "ready")
        self.assertEqual([call.args[0] for call in self.provider.await_args_list], [b"0:300", b"300:300", b"600:1"])
        async with self.Session() as db:
            rows = (await db.execute(select(TranscriptionUsage))).scalars().all()
            self.assertEqual(sorted(row.seconds for row in rows), [300, 301, 601])

    async def test_running_job_is_resumed_after_process_restart(self):
        await self.start()
        async with self.Session() as db:
            job = await db.get(RecordingTranscript, self.rec.id)
            job.status, job.processed_seconds, job.text = "running", 300, "Сохранённый текст"
            await db.commit()
        await service.run_next(self.Session)
        saved = (await self.client.get(self.url)).json()
        self.assertTrue(saved["text"].startswith("Сохранённый текст"))
        self.assertEqual([c.args[0] for c in self.provider.await_args_list], [b"300:300", b"600:1"])

    async def test_source_access_controls_apply_to_text_and_worker(self):
        await self.start()
        self.who = "carol"  # Не участник Звезды.
        self.assertIn((await self.client.get(self.url)).status_code, (403, 404))
        self.assertIn((await self.start()).status_code, (403, 404))
        self.who = "alice"
        async with self.Session() as db:
            room = await db.get(StarChannel, self.room.id)
            room.access = "personal"; room.cabinet_owner_id = self.users["bob"].id
            await db.commit()
        self.assertIn((await self.client.get(self.url)).status_code, (403, 404))
        await service.run_next(self.Session)
        self.provider.assert_not_awaited()
        self.normalize.assert_not_called()

    async def test_deleted_and_expired_recordings_cannot_expose_text(self):
        await self.start(); await service.run_next(self.Session)
        async with self.Session() as db:
            await recordings.sweep(db, recordings._now() + timedelta(days=91))
            self.assertIsNone(await db.get(RecordingTranscript, self.rec.id))
        self.assertIn((await self.client.get(self.url)).status_code, (404, 409))

    async def test_provider_failure_requires_manual_retry_and_preserves_progress(self):
        await self.start()
        self.provider.side_effect = ["Первая часть", HTTPException(502, "Cloudflare недоступен")]
        await service.run_next(self.Session)
        saved = (await self.client.get(self.url)).json()
        self.assertEqual((saved["status"], saved["processed_seconds"]), ("failed", 300))
        self.assertIn("Первая часть", saved["text"])
        self.assertFalse(await service.run_next(self.Session))

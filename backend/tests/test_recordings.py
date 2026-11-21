"""Запись встреч в комнатах рабочих Звёзд: кто включает, куски по порядку, сообщение в чате комнаты,
завершение при выходе, пропавшие записи и удаление через 90 дней. Нужна PostgreSQL."""

import json
import subprocess
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
import httpx

from app.api import recordings as rec_api
from app.api import star_files as files_api
from app.api import stars as api
from app.api import voice as voice_api
from app.core import livekit, recordings, star_files, voice
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.recording import RoomRecording
from app.models.star import StarFile
from tests.stars_base import StarsTestBase
from tests.voice_fakes import FakeRoomService, configure_livekit


class RecordingsTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        configure_livekit(self)
        self.lk = FakeRoomService()
        for patcher in (
            mock.patch.object(livekit, "room_service", self.lk),
            mock.patch.object(settings, "MEDIA_ROOT", tempfile.mkdtemp()),
            mock.patch.object(settings, "MEDIA_MIN_FREE_MB", 0),
            # Сервер без ffmpeg — файлы остаются как есть.
            mock.patch.object(recordings.shutil, "which", lambda _name: None),
            mock.patch.object(voice, "session_factory", self.Session),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.star = await self.star_with_roles("work")
        self.room = next(c for c in self.star.channels if c.kind == "planet" and c.room_kind != "meeting")
        app = FastAPI()
        app.include_router(rec_api.router)
        app.include_router(files_api.router)

        async def database():
            async with self.Session() as db:
                yield db

        app.dependency_overrides[get_db] = database
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    def uid(self, name):
        return self.users[name].id

    def bearer(self, name):
        return {"Authorization": "Bearer " + create_access_token(self.uid(name))}

    async def enter(self, user, channel=None):
        channel = channel or self.room
        out = await self.call(voice_api.join_planet, self.star.id, channel.id, user=user)
        self.lk.rooms.setdefault(out.room, set()).add(self.uid(user))
        await voice.handle_webhook(
            {"event": "participant_joined", "room": {"name": out.room}, "participant": {"identity": self.uid(user)}}
        )

    async def leave(self, user, channel=None):
        room = voice.room_name((channel or self.room).id)
        self.lk.rooms.get(room, set()).discard(self.uid(user))
        await voice.handle_webhook(
            {"event": "participant_left", "room": {"name": room}, "participant": {"identity": self.uid(user)}}
        )

    async def start(self, user, channel=None, star=None):
        star_id = (star or self.star).id
        return await self.client.post(f"/stars/{star_id}/planets/{(channel or self.room).id}/recording",
                                      headers=self.bearer(user), json={"label": "21.11 14:00"})

    async def chunk(self, rec_id, kind, seq, data, user="mod"):
        return await self.client.put(f"/stars/{self.star.id}/recordings/{rec_id}/{kind}?seq={seq}",
                                     headers=self.bearer(user), content=data)

    async def stop(self, rec_id, user="mod"):
        return await self.client.post(f"/stars/{self.star.id}/recordings/{rec_id}/stop", headers=self.bearer(user))

    def recording_flag(self, user):
        return any(p.user_id == self.uid(user) and p.recording for p in voice.participants(self.room.id))

    async def feed(self, user):
        return await self.call(api.list_messages, self.star.id, self.room.id, user=user, limit=50, before_id=None)

    async def test_moderators_and_the_host_record_inside_a_work_room(self):
        await self.enter("bob")
        await self.enter("mod")
        # Боб вошёл первым — он главный в комнате и может записывать.
        self.assertEqual(voice.host(self.room.id), self.uid("bob"))
        self.assertEqual((await self.start("owner")).status_code, 409)  # владелец, но не в комнате
        await self.enter("alice")
        self.assertEqual((await self.start("alice")).status_code, 403)  # просто участник
        response = await self.start("mod")
        self.assertEqual(response.status_code, 201, response.text)
        self.assertTrue(self.recording_flag("mod"))
        self.assertTrue(any(e["type"] == "star_voice" and any(p["recording"] for p in e["participants"])
                            for _, e in self.events))
        self.assertEqual((await self.start("bob")).status_code, 409)  # уже идёт
        # Гости по ссылке узнают о записи из метаданных комнаты LiveKit.
        room = voice.room_name(self.room.id)
        self.assertTrue(json.loads(self.lk.metadata[room])["recording"])
        await self.stop(response.json()["id"])
        self.assertNotIn("recording", json.loads(self.lk.metadata[room]))

    async def test_gaming_stars_do_not_record(self):
        gaming = await self.star_with_roles("gaming")
        planet = next(c for c in gaming.channels if c.kind == "planet")
        out = await self.call(voice_api.join_planet, gaming.id, planet.id, user="owner")
        self.lk.rooms.setdefault(out.room, set()).add(self.uid("owner"))
        await voice.handle_webhook({"event": "participant_joined", "room": {"name": out.room},
                                    "participant": {"identity": self.uid("owner")}})
        self.assertEqual((await self.start("owner", planet, gaming)).status_code, 403)

    async def test_chunks_in_order_then_a_message_with_video_and_audio_in_the_room_chat(self):
        await self.enter("mod")
        rec_id = (await self.start("mod")).json()["id"]
        for seq, part in enumerate((b"AAAA", b"BBBB")):
            self.assertEqual((await self.chunk(rec_id, "video", seq, part)).status_code, 204)
        self.assertEqual((await self.chunk(rec_id, "audio", 0, b"zz")).status_code, 204)
        # Повтор принятого куска — не ошибка, пропуск — 409 с ожидаемым номером.
        self.assertEqual((await self.chunk(rec_id, "video", 1, b"BBBB")).status_code, 204)
        gap = await self.chunk(rec_id, "video", 5, b"CCCC")
        self.assertEqual((gap.status_code, gap.json()["detail"]), (409, {"expected": 2}))
        # Чужую запись дописать нельзя.
        await self.enter("bob")
        self.assertEqual((await self.chunk(rec_id, "video", 2, b"x", user="bob")).status_code, 404)

        self.assertEqual((await self.stop(rec_id)).status_code, 204)
        self.assertFalse(self.recording_flag("mod"))
        message = next(m for m in await self.feed("alice") if m.kind == "recording")
        self.assertEqual(message.recording.status, "finished")
        self.assertEqual(message.recording.video.size, 8)
        self.assertEqual(message.recording.audio.size, 2)
        self.assertIn("видео.webm", message.recording.video.name)
        self.assertIn("21.11 14-00", message.recording.video.name)
        self.assertEqual(star_files.file_path(message.recording.video.id).read_bytes(), b"AAAABBBB")
        # Файлы видят те, кто видит чат комнаты, и они проигрываются прямо в браузере.
        response = await self.client.get(f"/stars/{self.star.id}/files/{message.recording.video.id}", headers=self.bearer("alice"))
        self.assertEqual((response.status_code, response.headers["content-type"]), (200, "video/webm"))
        self.assertEqual((await self.chunk(rec_id, "video", 2, b"late")).status_code, 409)

        # Ссылка на час для плеера: без заголовка входа, с перемоткой (Range → 206).
        link = await self.client.get(f"/stars/{self.star.id}/files/{message.recording.video.id}/link", headers=self.bearer("alice"))
        self.assertEqual(link.status_code, 200)
        url = link.json()["url"]
        part = await self.client.get(url, headers={"Range": "bytes=4-7"})
        self.assertEqual((part.status_code, part.content), (206, b"BBBB"))
        self.assertEqual((await self.client.get(url.replace("&s=", "&s=0"))).status_code, 403)
        expired = await self.client.get(url.split("?")[0] + "?e=1&s=" + url.split("&s=")[1])
        self.assertEqual(expired.status_code, 403)
        self.assertEqual((await self.client.get(f"/stars/{self.star.id}/files/{message.recording.video.id}/link",
                                                headers=self.bearer("carol"))).status_code, 404)

    async def test_the_recording_ends_when_its_author_leaves_the_room(self):
        await self.enter("mod")
        rec_id = (await self.start("mod")).json()["id"]
        await self.chunk(rec_id, "audio", 0, b"hello")
        await self.enter("bob")
        await self.leave("mod")
        async with self.Session() as db:
            self.assertEqual((await db.get(RoomRecording, rec_id)).status, "finished")
        self.assertNotIn("recording", json.loads(self.lk.metadata[voice.room_name(self.room.id)]))
        self.assertTrue(any(m.kind == "recording" for m in await self.feed("owner")))

    async def test_nothing_recorded_leaves_no_message(self):
        await self.enter("mod")
        rec_id = (await self.start("mod")).json()["id"]
        await self.stop(rec_id)
        async with self.Session() as db:
            self.assertEqual((await db.get(RoomRecording, rec_id)).status, "empty")
        self.assertFalse(any(m.kind == "recording" for m in await self.feed("owner")))

    async def test_lost_recordings_finish_and_old_ones_are_deleted_after_90_days(self):
        await self.enter("mod")
        rec_id = (await self.start("mod")).json()["id"]
        await self.chunk(rec_id, "video", 0, b"vid")
        # Пока включивший в комнате, тишина в кусках запись не обрывает.
        async with self.Session() as db:
            await recordings.sweep(db, recordings._now() + timedelta(minutes=10))
            self.assertEqual((await db.get(RoomRecording, rec_id)).status, "recording")
        # Пропал из комнаты (вкладку закрыли, а выход ещё не дошёл) — запись завершается.
        voice._planets[self.room.id].participants.pop(self.uid("mod"))
        async with self.Session() as db:
            await recordings.sweep(db, recordings._now() + timedelta(minutes=3))
            rec = await db.get(RoomRecording, rec_id)
            self.assertEqual(rec.status, "finished")
            video_id = rec.video_file_id
        async with self.Session() as db:
            await recordings.sweep(db, recordings._now() + timedelta(days=91))
            self.assertEqual((await db.get(RoomRecording, rec_id)).status, "expired")
            self.assertIsNone(await db.get(StarFile, video_id))
        self.assertFalse(star_files.file_path(video_id).exists())
        message = next(m for m in await self.feed("owner") if m.kind == "recording")
        self.assertEqual((message.recording.status, message.recording.video), ("expired", None))

    async def test_in_progress_files_survive_the_orphan_sweep_and_get_remuxed(self):
        await self.enter("mod")
        rec_id = (await self.start("mod")).json()["id"]
        await self.chunk(rec_id, "video", 0, b"raw")
        async with self.Session() as db:
            rec = await db.get(RoomRecording, rec_id)
            path = star_files.file_path(rec.video_file_id)
            old = path.stat().st_mtime - 2 * star_files.ORPHAN_FILE_GRACE_SEC
            import os
            os.utime(path, (old, old))
            await star_files.sweep(db)
        self.assertTrue(path.exists())

        calls = []

        def fake_ffmpeg(args, **_kwargs):
            calls.append(args)
            Path(args[-1]).write_bytes(b"remuxed")
            return subprocess.CompletedProcess(args, 0)

        with mock.patch.object(recordings.shutil, "which", lambda _name: "/usr/bin/ffmpeg"), \
                mock.patch.object(recordings.subprocess, "run", fake_ffmpeg):
            await self.stop(rec_id)
        self.assertEqual(path.read_bytes(), b"remuxed")
        self.assertIn("-c", calls[0])
        self.assertEqual(calls[0][calls[0].index("-c") + 1], "copy")

    async def test_a_moderator_stops_someone_elses_recording_from_the_room(self):
        await self.enter("bob")  # главный в комнате, не модератор Звезды
        rec_id = (await self.start("bob")).json()["id"]
        await self.chunk(rec_id, "video", 0, b"vid", user="bob")
        url = f"/stars/{self.star.id}/planets/{self.room.id}/recording/stop"
        # Просто участник чужую запись не останавливает.
        self.assertEqual((await self.client.post(url, headers=self.bearer("alice"))).status_code, 403)
        # Модератор — может, даже не заходя в комнату.
        self.assertEqual((await self.client.post(url, headers=self.bearer("mod"))).status_code, 204)
        self.assertFalse(self.recording_flag("bob"))
        async with self.Session() as db:
            rec = await db.get(RoomRecording, rec_id)
            self.assertEqual((rec.status, rec.stopped_by), ("finished", self.uid("mod")))
        self.assertTrue(any(m.kind == "recording" for m in await self.feed("alice")))
        # Включивший узнаёт об этом со следующим куском.
        late = await self.chunk(rec_id, "video", 1, b"more", user="bob")
        self.assertEqual(late.status_code, 409)
        self.assertIn("остановил модератор", late.json()["detail"])
        # Записи больше нет — останавливать нечего.
        self.assertEqual((await self.client.post(url, headers=self.bearer("mod"))).status_code, 404)

    async def test_the_author_stopping_their_own_recording_is_not_a_moderator_stop(self):
        await self.enter("mod")
        rec_id = (await self.start("mod")).json()["id"]
        await self.chunk(rec_id, "audio", 0, b"a")
        url = f"/stars/{self.star.id}/planets/{self.room.id}/recording/stop"
        self.assertEqual((await self.client.post(url, headers=self.bearer("mod"))).status_code, 204)
        late = await self.chunk(rec_id, "audio", 1, b"b")
        self.assertEqual(late.json()["detail"], "Запись уже остановлена")

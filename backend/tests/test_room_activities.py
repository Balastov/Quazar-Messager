import asyncio
import shutil
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError
from sqlalchemy import update

from app.api import room_activities as api
from app.core import room_activities as activity
from app.core import star_files, voice
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.room_activity import RoomVideo
from app.models.star import StarFile, StarMember
from app.schemas.room_activity import BoardItemBody, FocusAction, VideoAction, PointersBody
from tests.stars_base import StarsTestBase


class VideoRequest:
    def __init__(self, payload=b"\x00\x00\x00\x18ftypmp42" + b"0" * 100, mime="video/mp4"):
        self.payload = payload
        self.headers = {"content-type": mime, "content-length": str(len(payload))}

    async def stream(self):
        yield self.payload


class RoomActivitiesTest(StarsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.star = await self.star_with_roles()
        self.planet = next(c for c in self.star.channels if c.kind == "planet")
        self.satellite = next(c for c in self.star.channels if c.kind == "satellite")
        for name in ("alice", "bob"):
            voice._add(self.star.id, self.planet.id, self.users[name].id)
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, True)
        for patcher in (mock.patch.object(settings, "MEDIA_ROOT", self.media),
                        mock.patch.object(settings, "MEDIA_MIN_FREE_MB", 0),
                        mock.patch.object(activity, "session_factory", self.Session)):
            patcher.start(); self.addCleanup(patcher.stop)
        activity._pointer_times.clear()
        self.events.clear()

    async def state(self, user="alice"):
        return await self.call(api.get_state, self.star.id, self.planet.id, user=user)

    async def put(self, item_id, body, user="alice"):
        return await self.call(api.put_board_item, self.star.id, self.planet.id, item_id, body, user=user)

    async def focus(self, action, user="alice", **kwargs):
        state = await self.state(user)
        body = FocusAction(action=action, version=(state["focus"] or {}).get("version", 0), **kwargs)
        return await self.call(api.focus_action, self.star.id, self.planet.id, body, user=user)

    async def video(self, action, user="alice", **kwargs):
        state = await self.state(user)
        body = VideoAction(action=action, version=(state["video"] or {}).get("version", 0), **kwargs)
        return await self.call(api.video_action, self.star.id, self.planet.id, body, user=user)

    async def upload(self, user="alice", request=None):
        return await self.call(api.upload_video, self.star.id, self.planet.id, request or VideoRequest(),
                               name="ролик.mp4", duration=100, user=user)

    async def test_only_current_room_participants_can_read_or_write(self):
        self.assertIsNone((await self.state())["focus"])
        await self.expect_error(403, api.get_state, self.star.id, self.planet.id, user="owner")
        await self.expect_error(404, api.get_state, self.star.id, self.planet.id, user="carol")
        await self.expect_error(400, api.get_state, self.star.id, self.satellite.id, user="alice")
        await self.expect_error(403, api.put_board_item, self.star.id, self.planet.id, uuid.uuid4(),
                                BoardItemBody(kind="note", text="Секрет"), user="owner")

    async def test_board_is_shared_persistent_and_events_stay_inside_the_room(self):
        item_id = uuid.uuid4()
        item = await self.put(item_id, BoardItemBody(kind="note", text="Общий план"))
        state = await self.state("bob")
        self.assertEqual(state["board"], [item])
        self.assertEqual({uid for uid, _ in self.events}, {self.users["alice"].id, self.users["bob"].id})
        edited = await self.put(item_id, BoardItemBody(kind="note", text="Изменил Боб", revision=item["revision"]), "bob")
        self.assertGreater(edited["revision"], item["revision"])
        self.assertEqual((await self.state())["board"][0]["text"], "Изменил Боб")
        await self.expect_error(409, api.put_board_item, self.star.id, self.planet.id, item_id,
                                BoardItemBody(kind="note", text="Старая правка", revision=item["revision"]), user="alice")

    async def test_two_concurrent_edits_cannot_silently_overwrite_each_other(self):
        item_id = uuid.uuid4()
        item = await self.put(item_id, BoardItemBody(kind="card", text="Начало"))
        results = await asyncio.gather(
            self.put(item_id, BoardItemBody(kind="card", text="А", revision=item["revision"])),
            self.put(item_id, BoardItemBody(kind="card", text="Б", revision=item["revision"]), "bob"),
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        errors = [result for result in results if isinstance(result, HTTPException)]
        self.assertEqual([error.status_code for error in errors], [409])

    async def test_deleting_and_clearing_board_check_revisions_and_host(self):
        item_id = uuid.uuid4()
        item = await self.put(item_id, BoardItemBody(kind="note", text="A"))
        await self.expect_error(409, api.delete_board_item, self.star.id, self.planet.id, item_id,
                                revision=item["revision"] + 1, user="bob")
        await self.call(api.delete_board_item, self.star.id, self.planet.id, item_id, revision=item["revision"], user="bob")
        await self.put(uuid.uuid4(), BoardItemBody(kind="stroke", points=[{"x": 1, "y": 2}, {"x": 5, "y": 6}]))
        await self.expect_error(403, api.clear_board, self.star.id, self.planet.id, user="bob")
        await self.call(api.clear_board, self.star.id, self.planet.id, user="alice")
        self.assertEqual((await self.state())["board"], [])

    async def test_invalid_board_data_and_limit_are_rejected(self):
        for body in ({"kind": "note", "text": " "}, {"kind": "stroke", "points": [{"x": -1, "y": 0}]},
                     {"kind": "note", "text": "x", "color": "url(javascript:bad)"},
                     {"kind": "card", "text": "x", "x": float("nan")}):
            with self.assertRaises(ValidationError):
                BoardItemBody(**body)
        with mock.patch.object(api, "MAX_BOARD_ITEMS", 1):
            await self.put(uuid.uuid4(), BoardItemBody(kind="note", text="A"))
            await self.expect_error(409, api.put_board_item, self.star.id, self.planet.id, uuid.uuid4(),
                                    BoardItemBody(kind="note", text="B"), user="alice")

    async def test_focus_survives_reloads_and_automatically_enters_break_then_finishes(self):
        start = datetime.now(timezone.utc)
        with mock.patch.object(activity, "now", return_value=start):
            first = await self.focus("start", work_minutes=1, break_minutes=1)
            self.assertEqual(first["focus"]["phase"], "work")
            self.assertEqual((await self.state("bob"))["focus"], first["focus"])
        async with self.Session() as db:
            self.assertEqual(await activity.tick(db, start + timedelta(seconds=61)), 1)
        with mock.patch.object(activity, "now", return_value=start + timedelta(seconds=61)):
            self.assertEqual((await self.state())["focus"]["phase"], "break")
        async with self.Session() as db:
            self.assertEqual(await activity.tick(db, start + timedelta(seconds=121)), 1)
        final = await self.state()
        self.assertEqual(final["focus"]["phase"], "done")
        self.assertFalse(final["focus"]["running"])

    async def test_focus_pause_resume_permissions_and_takeover(self):
        start = datetime.now(timezone.utc)
        with mock.patch.object(activity, "now", return_value=start):
            first = await self.focus("start", work_minutes=1)
        await self.expect_error(403, api.focus_action, self.star.id, self.planet.id,
                                FocusAction(action="pause", version=first["focus"]["version"]), user="bob")
        with mock.patch.object(activity, "now", return_value=start + timedelta(seconds=20)):
            paused = await self.focus("pause")
            self.assertEqual(paused["focus"]["remaining_seconds"], 40)
        with mock.patch.object(activity, "now", return_value=start + timedelta(minutes=10)):
            resumed = await self.focus("resume")
            self.assertEqual(datetime.fromisoformat(resumed["focus"]["ends_at"]), start + timedelta(minutes=10, seconds=40))
        voice._planets[self.planet.id].participants.pop(self.users["alice"].id)
        with mock.patch.object(activity, "now", return_value=start + timedelta(minutes=10, seconds=10)):
            takeover = await self.focus("pause", "bob")
            self.assertEqual(takeover["focus"]["owner_id"], self.users["bob"].id)

    async def test_video_queue_is_shared_and_controls_default_to_the_host(self):
        state = await self.upload()
        file_id = state["video"]["file_id"]
        self.assertEqual(len((await self.state("bob"))["videos"]), 1)
        await self.expect_error(403, api.video_action, self.star.id, self.planet.id,
                                VideoAction(action="play", version=state["video"]["version"]), user="bob")
        await self.video("share", shared_controls=True)
        playing = await self.video("play", "bob", position=12, duration=100)
        self.assertTrue(playing["video"]["playing"])
        paused = await self.video("pause", "bob", position=18, duration=100)
        self.assertEqual(paused["video"]["position"], 18)
        download = await self.call(api.get_video, self.star.id, self.planet.id, file_id, user="bob")
        self.assertEqual(download.media_type, "video/mp4")
        await self.expect_error(403, api.get_video, self.star.id, self.planet.id, file_id, user="owner")

    async def test_queue_next_is_versioned_and_videos_can_be_removed(self):
        first = await self.upload()
        state = await self.upload("bob")
        second_id = state["videos"][1]["id"]
        next_state = await self.video("next", file_id=first["video"]["file_id"])
        self.assertEqual(next_state["video"]["file_id"], second_id)
        await self.expect_error(409, api.video_action, self.star.id, self.planet.id,
                                VideoAction(action="next", version=first["video"]["version"], file_id=first["video"]["file_id"]), user="alice")
        removed = await self.call(api.delete_video, self.star.id, self.planet.id, second_id, user="bob")
        self.assertIsNone(removed["video"]["file_id"])
        self.assertIsNone(removed["video"]["duration"])
        self.assertFalse(star_files.file_path(second_id).exists())

    async def test_video_queue_advances_on_server_even_without_an_open_player(self):
        await self.upload()
        queued = await self.upload("bob")
        second_id = queued["videos"][1]["id"]
        started = await self.video("play", duration=100)
        at = datetime.fromisoformat(started["video"]["updated_at"])
        async with self.Session() as db:
            self.assertEqual(await activity.tick(db, at + timedelta(seconds=105)), 1)
        next_state = await self.state()
        self.assertEqual(next_state["video"]["file_id"], second_id)
        self.assertTrue(next_state["video"]["playing"])
        self.assertEqual(activity.video_position(next_state["video"], at + timedelta(seconds=105)), 5)
        async with self.Session() as db:
            self.assertEqual(await activity.tick(db, at + timedelta(seconds=205)), 1)
        self.assertFalse((await self.state())["video"]["playing"])
        self.assertIsNone((await self.state())["video"]["file_id"])

    async def test_room_videos_are_not_removed_as_unsent_attachments(self):
        state = await self.upload()
        file_id = state["video"]["file_id"]
        async with self.Session() as db:
            await db.execute(update(StarFile).where(StarFile.id == file_id).values(created_at=activity.now() - timedelta(days=2)))
            await db.commit()
            await star_files.sweep(db)
            self.assertIsNotNone(await db.get(StarFile, file_id))
            self.assertIsNotNone(await db.get(RoomVideo, file_id))
        self.assertTrue(star_files.file_path(file_id).exists())

    async def test_upload_rejects_documents_bad_containers_and_queue_overflow(self):
        await self.expect_error(422, api.upload_video, self.star.id, self.planet.id,
                                VideoRequest(b"<script>bad</script>", "text/html"), name="x.mp4", user="alice")
        await self.expect_error(422, api.upload_video, self.star.id, self.planet.id,
                                VideoRequest(b"<script>bad</script>"), name="x.mp4", user="alice")
        with mock.patch.object(api, "MAX_VIDEOS", 1):
            await self.upload()
            await self.expect_error(409, api.upload_video, self.star.id, self.planet.id, VideoRequest(), name="x.mp4", user="bob")
        self.assertEqual(len(list(star_files.files_dir().iterdir())), 1)

    async def test_leaving_while_uploading_cannot_publish_a_video_and_cleans_up_the_file(self):
        outer = self
        class LeavingRequest(VideoRequest):
            async def stream(self):
                yield self.payload[:12]
                voice._planets[outer.planet.id].participants.pop(outer.users["alice"].id)
                yield self.payload[12:]
        await self.expect_error(403, api.upload_video, self.star.id, self.planet.id,
                                LeavingRequest(), name="ролик.mp4", user="alice")
        self.assertEqual(list(star_files.files_dir().iterdir()), [])
        self.assertEqual((await self.state("bob"))["videos"], [])

    async def test_pointers_need_sharer_consent_authentic_identity_and_valid_coordinates(self):
        voice._participant(self.planet.id, self.users["alice"].id).screen_sharing = True
        body = {"type": "room_pointer", "star_id": self.star.id, "channel_id": self.planet.id,
                "sharer_id": self.users["alice"].id, "x": 0.25, "y": 0.75, "user_id": "forged"}
        await activity.handle_pointer(body, self.users["bob"].id)
        self.assertFalse(any(event["type"] == "room_pointer" for _, event in self.events))
        activity._pointer_times.clear()
        await self.expect_error(403, api.set_pointers, self.star.id, self.planet.id, PointersBody(enabled=True), user="bob")
        await self.call(api.set_pointers, self.star.id, self.planet.id, PointersBody(enabled=True), user="alice")
        self.events.clear()
        await activity.handle_pointer({**body, "x": float("nan")}, self.users["bob"].id)
        await activity.handle_pointer(body, self.users["owner"].id)
        self.assertEqual(self.events, [])
        await activity.handle_pointer(body, self.users["bob"].id)
        events = [event for _, event in self.events if event["type"] == "room_pointer"]
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["user_id"], self.users["bob"].id)
        self.assertEqual(events[0]["x"], 0.25)
        self.assertEqual(events[0]["name"], self.users["bob"].display_name)
        await activity.handle_pointer(body, self.users["bob"].id)
        self.assertEqual(len(self.events), 2)

    async def test_timeout_blocks_writes_but_does_not_hide_existing_content(self):
        item_id = uuid.uuid4()
        await self.put(item_id, BoardItemBody(kind="note", text="План"))
        async with self.Session() as db:
            await db.execute(update(StarMember).where(StarMember.star_id == self.star.id,
                StarMember.user_id == self.users["bob"].id).values(timeout_until=activity.now() + timedelta(hours=1)))
            await db.commit()
        self.assertEqual(len((await self.state("bob"))["board"]), 1)
        await self.expect_error(403, api.put_board_item, self.star.id, self.planet.id, uuid.uuid4(),
                                BoardItemBody(kind="note", text="Нельзя"), user="bob")

    async def test_http_routes_validate_payloads_and_serve_authorized_video_bytes(self):
        app = FastAPI()
        app.include_router(api.router)
        async def database():
            async with self.Session() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.users["alice"]
        base = f"/stars/{self.star.id}/planets/{self.planet.id}/activities"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            initial = await client.get(base)
            self.assertEqual(initial.status_code, 200)
            invalid = await client.put(f"{base}/board/{uuid.uuid4()}", json={"kind": "note", "text": "x", "color": "invalid"})
            self.assertEqual(invalid.status_code, 422)
            request = VideoRequest()
            uploaded = await client.post(f"{base}/videos", params={"name": "clip.mp4", "duration": 100},
                                         content=request.payload, headers={"Content-Type": "video/mp4"})
            self.assertEqual(uploaded.status_code, 201, uploaded.text)
            file_id = uploaded.json()["video"]["file_id"]
            response = await client.get(f"{base}/videos/{file_id}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, request.payload)
            self.assertEqual(response.headers["content-type"], "video/mp4")
            self.assertEqual(response.headers["cache-control"], "private, no-store")
            invalid_duration = await client.post(f"{base}/videos", params={"name": "bad.mp4", "duration": "NaN"},
                                                 content=request.payload, headers={"Content-Type": "video/mp4"})
            self.assertEqual(invalid_duration.status_code, 422)

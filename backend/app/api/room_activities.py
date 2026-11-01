"""Активности Планет/Комнат: указатели, фокус, общая доска, загруженные видеоролики."""

import uuid
from datetime import timedelta
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy import func, select

from app.api.later import CurrentUser, Db
from app.api.stars import _load_membership, assert_can_post
from app.api.voice import _planet
from app.core import room_activities as activity
from app.core import star_files, voice
from app.core.config import settings
from app.models.room_activity import RoomActivity, RoomVideo
from app.models.star import StarChannel, StarFile
from app.schemas.room_activity import BoardItemBody, FocusAction, PointersBody, VideoAction

router = APIRouter(prefix="/stars/{star_id}/planets/{channel_id}/activities", tags=["room activities"])
MAX_BOARD_ITEMS = 300
MAX_VIDEOS = 20
VIDEO_MIMES = {"video/mp4", "video/webm", "video/ogg"}


async def room(db, star_id: str, channel_id: str, user, *, write=False):
    star, me = await _load_membership(db, star_id, user.id)
    channel = await _planet(db, star_id, channel_id)
    if user.id not in activity.members(channel_id):
        raise HTTPException(status_code=403, detail="Сначала войдите в эту комнату")
    if write:
        assert_can_post(star, me)
    return star, me, channel


async def locked(db, star_id: str, channel_id: str, user):
    star, me, channel = await room(db, star_id, channel_id, user, write=True)
    await db.execute(select(StarChannel.id).where(StarChannel.id == channel_id).with_for_update())
    row = (await db.execute(select(RoomActivity).where(RoomActivity.channel_id == channel_id).with_for_update())).scalar_one_or_none()
    if row is None:
        row = RoomActivity(star_id=star_id, channel_id=channel_id, revision=0, board={}, focus={}, video={})
        db.add(row)
        await db.flush()
    return row, me


def controls(channel_id: str, user_id: str, me, state: dict) -> bool:
    return (state.get("owner_id") == user_id or me.role in ("owner", "admin", "moderator")
            or voice.host(channel_id) == user_id or state.get("owner_id") not in activity.members(channel_id))


def check_version(current: dict, expected: int):
    if current.get("version", 0) != expected:
        raise HTTPException(status_code=409, detail="Состояние изменилось. Обновите его и повторите действие")


async def videos(db, channel_id: str) -> list[dict]:
    rows = (await db.execute(select(StarFile, RoomVideo.duration).join(RoomVideo, RoomVideo.file_id == StarFile.id)
                            .where(RoomVideo.channel_id == channel_id).order_by(StarFile.created_at))).all()
    return [{"id": f.id, "name": f.name, "mime": f.mime, "size": f.size, "uploader_id": f.uploader_id,
             "duration": duration} for f, duration in rows]


async def snapshot(db, star_id: str, channel_id: str, row: RoomActivity | None) -> dict:
    sharer = voice.screen_sharer(channel_id)
    return {
        "star_id": star_id, "channel_id": channel_id, "revision": row.revision if row else 0,
        "board": list((row.board if row else {}).values()),
        "focus": (activity.advance_focus(row.focus, activity.now()) or None) if row else None,
        "video": (row.video or None) if row else None, "videos": await videos(db, channel_id),
        "pointers_sharer_id": row.pointers_sharer_id if row and sharer and row.pointers_sharer_id == sharer.user_id else None,
        "server_time": activity.now().isoformat(),
    }


async def state_event(db, row: RoomActivity):
    out = await snapshot(db, row.star_id, row.channel_id, row)
    out.pop("board")
    await activity.broadcast(row.channel_id, {"type": "room_activity_state", **out})


@router.get("")
async def get_state(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    await room(db, star_id, channel_id, current_user)
    return await snapshot(db, star_id, channel_id, await db.get(RoomActivity, channel_id))


@router.put("/pointers")
async def set_pointers(star_id: str, channel_id: str, body: PointersBody, current_user: CurrentUser, db: Db):
    row, _ = await locked(db, star_id, channel_id, current_user)
    sharer = voice.screen_sharer(channel_id)
    if not sharer or sharer.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Указатели включает тот, кто показывает экран")
    row.pointers_sharer_id = current_user.id if body.enabled else None
    row.revision += 1
    await db.commit()
    await state_event(db, row)
    return await snapshot(db, star_id, channel_id, row)


@router.put("/board/{item_id}")
async def put_board_item(star_id: str, channel_id: str, item_id: uuid.UUID, body: BoardItemBody, current_user: CurrentUser, db: Db):
    row, _ = await locked(db, star_id, channel_id, current_user)
    key = str(item_id)
    old = row.board.get(key)
    if (old or {}).get("revision", 0) != body.revision:
        raise HTTPException(status_code=409, detail="Этот объект уже изменили. Повторите действие")
    if not old and len(row.board) >= MAX_BOARD_ITEMS:
        raise HTTPException(status_code=409, detail="На доске уже 300 объектов — удалите ненужные")
    row.revision += 1
    item = {**body.model_dump(), "id": key, "revision": row.revision, "updated_by": current_user.id}
    row.board = {**row.board, key: item}
    await db.commit()
    await activity.broadcast(channel_id, {"type": "room_board_item", "star_id": star_id, "channel_id": channel_id,
                                         "item_id": key, "item": item, "revision": row.revision})
    return item


@router.delete("/board/{item_id}")
async def delete_board_item(star_id: str, channel_id: str, item_id: uuid.UUID, current_user: CurrentUser, db: Db,
                            revision: int = Query(..., ge=1)):
    row, _ = await locked(db, star_id, channel_id, current_user)
    key = str(item_id)
    old = row.board.get(key)
    if not old or old["revision"] != revision:
        raise HTTPException(status_code=409, detail="Этот объект уже изменили или удалили")
    row.board = {k: v for k, v in row.board.items() if k != key}
    row.revision += 1
    await db.commit()
    await activity.broadcast(channel_id, {"type": "room_board_item", "star_id": star_id, "channel_id": channel_id,
                                         "item_id": key, "item": None, "revision": row.revision})
    return {"revision": row.revision}


@router.delete("/board")
async def clear_board(star_id: str, channel_id: str, current_user: CurrentUser, db: Db):
    row, me = await locked(db, star_id, channel_id, current_user)
    if me.role not in ("owner", "admin", "moderator") and voice.host(channel_id) != current_user.id:
        raise HTTPException(status_code=403, detail="Очистить доску целиком может ведущий комнаты или модератор")
    row.board = {}
    row.revision += 1
    await db.commit()
    await activity.broadcast(channel_id, {"type": "room_board_reset", "star_id": star_id,
                                         "channel_id": channel_id, "revision": row.revision})
    return {"revision": row.revision}


@router.post("/focus")
async def focus_action(star_id: str, channel_id: str, body: FocusAction, current_user: CurrentUser, db: Db):
    row, me = await locked(db, star_id, channel_id, current_user)
    at = activity.now()
    focus = activity.advance_focus(row.focus, at)
    check_version(focus, body.version)
    if focus.get("phase") not in (None, "done") and not controls(channel_id, current_user.id, me, focus):
        raise HTTPException(status_code=403, detail="Таймером управляет ведущий сеанса")
    version = focus.get("version", 0) + 1
    if focus and focus.get("owner_id") not in activity.members(channel_id):
        focus = {**focus, "owner_id": current_user.id}
    if body.action == "start":
        if focus and focus.get("phase") != "done":
            raise HTTPException(status_code=409, detail="В комнате уже идёт сеанс фокуса")
        focus = {"owner_id": current_user.id, "phase": "work", "running": True,
                 "work_seconds": body.work_minutes * 60, "break_seconds": body.break_minutes * 60,
                 "remaining_seconds": body.work_minutes * 60, "ends_at": (at + timedelta(minutes=body.work_minutes)).isoformat()}
    elif not focus or focus.get("phase") == "done":
        raise HTTPException(status_code=409, detail="Сеанс фокуса уже завершён")
    elif body.action == "pause":
        focus = {**focus, "remaining_seconds": activity.focus_remaining(focus, at), "running": False, "ends_at": None}
    elif body.action == "resume":
        focus = {**focus, "running": True, "ends_at": (at + timedelta(seconds=activity.focus_remaining(focus, at))).isoformat()}
    elif body.action == "break":
        focus = {**focus, "phase": "break", "running": True, "remaining_seconds": focus["break_seconds"],
                 "ends_at": (at + timedelta(seconds=focus["break_seconds"])).isoformat()}
    elif body.action == "stop":
        focus = {**focus, "phase": "done", "running": False, "remaining_seconds": 0, "ends_at": None}
    row.focus = {**focus, "version": version}
    row.revision += 1
    await db.commit()
    await state_event(db, row)
    return await snapshot(db, star_id, channel_id, row)


@router.post("/videos", status_code=201)
async def upload_video(star_id: str, channel_id: str, request: Request, current_user: CurrentUser, db: Db,
                       name: str = Query(..., min_length=1, max_length=1024),
                       duration: float | None = Query(None, gt=0, le=86400, allow_inf_nan=False)):
    await room(db, star_id, channel_id, current_user, write=True)
    mime = star_files.clean_mime(request.headers.get("content-type"))
    if mime not in VIDEO_MIMES:
        raise HTTPException(status_code=422, detail="Выберите видео MP4, WebM или Ogg")
    # Один общий потолок места с файлами Спутников. Блокировка Звезды исключает гонку загрузок комнат.
    from app.models.star import Star
    await db.execute(select(Star.id).where(Star.id == star_id).with_for_update())
    if len(await videos(db, channel_id)) >= MAX_VIDEOS:
        raise HTTPException(status_code=409, detail="В очереди уже 20 роликов — удалите ненужные")
    used = (await db.execute(select(func.coalesce(func.sum(StarFile.size), 0)).where(StarFile.star_id == star_id))).scalar_one()
    remaining = settings.STAR_FILES_QUOTA_MB * 1024 * 1024 - int(used)
    limit = min(star_files.MAX_FILE_BYTES, remaining)
    if limit <= 0:
        raise HTTPException(status_code=507, detail="В Звезде закончилось место под файлы")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="Видео больше 50 МБ или оставшегося места в Звезде")
    try:
        star_files.ensure_free_space()
    except star_files.StorageFull:
        raise HTTPException(status_code=507, detail="На сервере закончилось место") from None
    file_id = str(uuid.uuid4())
    try:
        size = await star_files.save_stream(file_id, request.stream(), limit=limit)
        if not size:
            raise HTTPException(status_code=422, detail="Пустой файл")
        # Файл должен быть контейнером видео, а не произвольным документом с подменённым MIME.
        with star_files.file_path(file_id).open("rb") as file:
            header = file.read(64)
        valid = ((mime == "video/mp4" and header[4:8] == b"ftyp") or
                 (mime == "video/webm" and header[:4] == b"\x1aE\xdf\xa3") or
                 (mime == "video/ogg" and header[:4] == b"OggS"))
        if not valid:
            raise HTTPException(status_code=422, detail="Файл не похож на выбранный формат видео")
        # Долгая загрузка не держит блокировку таймера/доски. После неё проверяем, что
        # отправитель всё ещё в комнате, и только теперь меняем общую очередь.
        row, _ = await locked(db, star_id, channel_id, current_user)
        db.add(StarFile(id=file_id, star_id=star_id, channel_id=channel_id, uploader_id=current_user.id,
                        name=star_files.clean_name(unquote(name)), mime=mime, size=size))
        await db.flush()
        db.add(RoomVideo(file_id=file_id, channel_id=channel_id, duration=duration))
        if not row.video.get("file_id"):
            row.video = {"file_id": file_id, "owner_id": current_user.id, "playing": False, "position": 0,
                         "updated_at": activity.now().isoformat(), "shared_controls": False,
                         "duration": duration, "version": row.video.get("version", 0) + 1}
        row.revision += 1
        await db.commit()
    except star_files.FileTooLarge:
        star_files.delete_file(file_id)
        raise HTTPException(status_code=413, detail="Видео больше 50 МБ или оставшегося места в Звезде") from None
    except BaseException:
        star_files.delete_file(file_id)
        raise
    await state_event(db, row)
    return await snapshot(db, star_id, channel_id, row)


@router.get("/videos/{file_id}")
async def get_video(star_id: str, channel_id: str, file_id: str, current_user: CurrentUser, db: Db):
    await room(db, star_id, channel_id, current_user)
    entry = await db.get(RoomVideo, file_id)
    file = await db.get(StarFile, file_id) if entry and entry.channel_id == channel_id else None
    if not file or not star_files.file_path(file_id).is_file():
        raise HTTPException(status_code=404, detail="Видео не найдено")
    return FileResponse(star_files.file_path(file_id), media_type=file.mime,
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.post("/video")
async def video_action(star_id: str, channel_id: str, body: VideoAction, current_user: CurrentUser, db: Db):
    row, me = await locked(db, star_id, channel_id, current_user)
    video, at = row.video, activity.now()
    check_version(video, body.version)
    allowed = controls(channel_id, current_user.id, me, video)
    if not allowed and (body.action == "share" or not video.get("shared_controls")):
        raise HTTPException(status_code=403, detail="Воспроизведением управляет ведущий")
    queue = await videos(db, channel_id)
    if video and video.get("owner_id") not in activity.members(channel_id):
        video = {**video, "owner_id": current_user.id}
    if body.action == "next" and body.file_id is not None and body.file_id != video.get("file_id"):
        raise HTTPException(status_code=409, detail="Этот ролик уже сменился")
    if body.action in ("select", "next"):
        ids = [f["id"] for f in queue]
        if body.action == "next":
            index = ids.index(video["file_id"]) + 1 if video.get("file_id") in ids else 0
            file_id = ids[index] if index < len(ids) else None
        else:
            file_id = body.file_id
            if file_id not in ids:
                raise HTTPException(status_code=404, detail="Видео не найдено в этой комнате")
        chosen = next((file for file in queue if file["id"] == file_id), None)
        video = {**video, "file_id": file_id, "position": 0, "playing": bool(file_id) and body.action == "next",
                 "duration": chosen["duration"] if chosen else None,
                 "owner_id": current_user.id if allowed else video.get("owner_id")}
    elif body.action == "share":
        video = {**video, "position": activity.video_position(video, at), "shared_controls": body.shared_controls}
    elif body.action == "stop":
        video = {**video, "playing": False, "position": 0}
    else:
        if not video.get("file_id"):
            raise HTTPException(status_code=409, detail="Сначала выберите ролик")
        position = body.position if body.position is not None else activity.video_position(video, at)
        duration = body.duration or video.get("duration")
        if duration:
            position = min(position, duration)
        video = {**video, "position": position, "duration": duration}
        if body.action in ("play", "pause"):
            video["playing"] = body.action == "play"
        if body.duration and video.get("file_id"):
            entry = await db.get(RoomVideo, video["file_id"])
            if entry:
                entry.duration = body.duration
    row.video = {**video, "updated_at": at.isoformat(), "version": row.video.get("version", 0) + 1}
    row.revision += 1
    await db.commit()
    await state_event(db, row)
    return await snapshot(db, star_id, channel_id, row)


@router.delete("/videos/{file_id}")
async def delete_video(star_id: str, channel_id: str, file_id: str, current_user: CurrentUser, db: Db):
    row, me = await locked(db, star_id, channel_id, current_user)
    entry = await db.get(RoomVideo, file_id)
    file = await db.get(StarFile, file_id) if entry and entry.channel_id == channel_id else None
    if not file:
        raise HTTPException(status_code=404, detail="Видео не найдено")
    if file.uploader_id != current_user.id and me.role not in ("owner", "admin", "moderator"):
        raise HTTPException(status_code=403, detail="Удалить ролик может загрузивший его участник или модератор")
    if row.video.get("file_id") == file_id:
        row.video = {**row.video, "file_id": None, "playing": False, "position": 0, "duration": None,
                     "version": row.video.get("version", 0) + 1, "updated_at": activity.now().isoformat()}
    await db.delete(file)
    row.revision += 1
    await db.commit()
    star_files.delete_file(file_id)
    await state_event(db, row)
    return await snapshot(db, star_id, channel_id, row)

"""Рабочая Звезда с закрытым этажом и гостевой ссылкой — для проверки в настоящем окне приложения."""
import json
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI

from app.core.database import AsyncSessionLocal
from app.core.security import create_access_token
from app.main import app as backend
from app.models.star import Star, StarChannel, StarFloor, StarGuestLink, StarMember
from app.models.user import User
from app.schemas.user import MeOut
from app.ws.router import router as ws_router
from tests.device_pairing_browser import Spa, tours_done


@asynccontextmanager
async def lifespan(app):
    async with backend.router.lifespan_context(backend):
        async with AsyncSessionLocal() as db:
            now = datetime.now(timezone.utc)
            people = {
                name: User(username=name, phone=f"+7999000030{i}", password_hash=None, first_name=first,
                           last_name=last, phone_discoverable=True, phone_verified_at=now, tutorials=tours_done())
                for i, (name, first, last) in enumerate([
                    ("guest_owner", "Ольга", "Владелец"), ("guest_alice", "Алиса", "Участник"), ("guest_carol", "Карина", "Гость"),
                ])
            }
            db.add_all(people.values())
            await db.flush()
            star = Star(name="Офис Альфа", kind="work", owner_id=people["guest_owner"].id)
            db.add(star)
            await db.flush()
            db.add_all([
                StarMember(star_id=star.id, user_id=people["guest_owner"].id, role="owner"),
                StarMember(star_id=star.id, user_id=people["guest_alice"].id, role="member"),
            ])
            hall = StarFloor(star_id=star.id, name="1 этаж", position=0, version=0, access="all")
            closed = StarFloor(star_id=star.id, name="Бухгалтерия", position=1, version=0, access="none")
            db.add_all([hall, closed])
            await db.flush()
            rooms = [
                StarChannel(star_id=star.id, kind="satellite", name="общий", position=0),
                StarChannel(star_id=star.id, kind="planet", name="Переговорка", position=1, room_kind="meeting",
                            capacity=8, floor_id=hall.id, map_x=1, map_y=1, map_w=5, map_h=4),
                StarChannel(star_id=star.id, kind="planet", name="Сейф", position=2, room_kind="meeting", access="invite",
                            capacity=6, floor_id=closed.id, map_x=1, map_y=1, map_w=5, map_h=4),
                StarChannel(star_id=star.id, kind="planet", name="Касса", position=3, room_kind="meeting",
                            capacity=6, floor_id=closed.id, map_x=8, map_y=1, map_w=5, map_h=4),
            ]
            db.add_all(rooms)
            await db.flush()
            link = StarGuestLink(code=secrets.token_urlsafe(12), star_id=star.id, channel_id=rooms[2].id,
                                 created_by=people["guest_owner"].id, expires_at=now + timedelta(hours=3))
            db.add(link)
            await db.commit()
            data = {
                "accounts": {
                    name: {"token": create_access_token(user.id), "user": MeOut.model_validate(user).model_dump(mode="json")}
                    for name, user in people.items()
                },
                "fixtures": {"star": star.id, "link": link.id, "code": link.code, "closed": closed.id},
            }
        path = Path(os.environ["PAIR_TEST_BOOTSTRAP"])
        path.write_text(json.dumps(data))
        path.chmod(0o600)
        yield


app = FastAPI(lifespan=lifespan)
app.mount("/api", backend)
app.include_router(ws_router)
app.mount("/", Spa(directory=str(Path(__file__).resolve().parents[2] / "web/dist"), html=True))

"""Synthetic accounts and conversations for the local real-renderer feature test."""
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from fastapi import FastAPI
from app.main import app as backend
from app.core.database import AsyncSessionLocal
from app.core.security import create_access_token
from app.models.user import User
from app.models.chat import Chat, ChatMember
from app.models.message import Message
from app.models.star import Star, StarMember, StarChannel, StarMessage
from app.schemas.user import MeOut
from app.ws.router import router as ws_router
from tests.device_pairing_browser import Spa

@asynccontextmanager
async def lifespan(app):
    async with backend.router.lifespan_context(backend):
        async with AsyncSessionLocal() as db:
            user = User(username="draft_tester", phone="+79990000201", password_hash=None, first_name="Тестовый", last_name="Пользователь", phone_discoverable=True, phone_verified_at=datetime.now(timezone.utc))
            other = User(username="draft_friend", phone="+79990000202", password_hash=None, first_name="Собеседник")
            db.add_all([user, other]); await db.flush()
            chats = [Chat(type="group", name=name) for name in ["Первый черновик", "Второй черновик"]]
            db.add_all(chats); await db.flush()
            for chat in chats:
                db.add_all([ChatMember(chat_id=chat.id, user_id=user.id, role="owner"), ChatMember(chat_id=chat.id, user_id=other.id, role="member")])
            edit = Message(chat_id=chats[0].id, sender_id=user.id, payload="Сообщение для правки")
            db.add(edit)
            star = Star(name="Тест черновиков", kind="gaming", owner_id=user.id)
            db.add(star); await db.flush()
            db.add_all([StarMember(star_id=star.id, user_id=user.id, role="owner"), StarMember(star_id=star.id, user_id=other.id, role="member")])
            channel = StarChannel(star_id=star.id, kind="satellite", name="Спутник черновиков", position=0)
            db.add(channel); await db.flush()
            root = StarMessage(star_id=star.id, channel_id=channel.id, sender_id=other.id, text="Корень тестовой ветки")
            db.add(root); await db.flush()
            db.add(StarMessage(star_id=star.id, channel_id=channel.id, sender_id=user.id, text="Ответ в тестовой ветке", thread_id=root.id))
            await db.commit()
            data = {"token": create_access_token(user.id), "user": MeOut.model_validate(user).model_dump(mode="json"),
                "fixtures": {"chats": [chat.id for chat in chats], "edit_message": edit.id, "star": star.id, "channel": channel.id, "thread": root.id}}
        path = Path(os.environ["PAIR_TEST_BOOTSTRAP"]); path.write_text(json.dumps(data)); path.chmod(0o600)
        yield

app = FastAPI(lifespan=lifespan)
app.mount("/api", backend)
app.include_router(ws_router)
app.mount("/", Spa(directory=str(Path(__file__).resolve().parents[2] / "web/dist"), html=True))

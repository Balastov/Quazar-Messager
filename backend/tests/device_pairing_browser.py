"""Loopback-only fixture for the real-renderer device-pairing integration test."""
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles

from app.main import app as backend
from app.core.database import AsyncSessionLocal
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.user import MeOut
from app.ws.router import router as ws_router


@asynccontextmanager
async def lifespan(app):
    async with backend.router.lifespan_context(backend):
        async with AsyncSessionLocal() as db:
            user = User(username="device_test", phone="+79990000111", password_hash=None,
                first_name="Тестовый", last_name="Пользователь", phone_discoverable=True,
                phone_verified_at=datetime.now(timezone.utc))
            db.add(user)
            await db.commit()
            data = {"token": create_access_token(user.id), "user": MeOut.model_validate(user).model_dump(mode="json"),
                    # Ещё два входа того же аккаунта — для переноса ключей на устройство, где уже вошли.
                    "extra_tokens": [create_access_token(user.id), create_access_token(user.id)]}
        path = Path(os.environ["PAIR_TEST_BOOTSTRAP"])
        path.write_text(json.dumps(data))
        path.chmod(0o600)
        yield


class Spa(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as error:
            if error.status_code != 404:
                raise
            return await super().get_response("index.html", scope)


app = FastAPI(lifespan=lifespan)
app.mount("/api", backend)
app.include_router(ws_router)
app.mount("/", Spa(directory=str(Path(__file__).resolve().parents[2] / "web/dist"), html=True))

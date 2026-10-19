import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy import text

from app.core.avatars import media_root
from app.core import voice
from app.core.config import settings
from app.core.database import Base, engine
from app.models import Call, PushSubscription, Star  # noqa: F401 — register tables for create_all
from app.api.auth import router as auth_router
from app.api.users import router as users_router
from app.api.chats import router as chats_router
from app.api.messages import router as messages_router
from app.api.calls import router as calls_router
from app.api.push import router as push_router
from app.api.doors import router as doors_router
from app.api.office import router as office_router
from app.api.stars import invites_router as star_invites_router
from app.api.stars import router as stars_router
from app.api.voice import router as voice_router
from app.api.voice import webhook_router as livekit_webhook_router
from app.api.stickers import FILES_PATH as STICKER_FILES_PATH
from app.api.stickers import StickerFiles
from app.api.stickers import router as stickers_router
from app.api.contacts import router as contacts_router
from app.core.stickers import STICKERS_DIR
from app.ws.router import router as ws_router


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        if settings.CONTENT_SECURITY_POLICY:
            response.headers.setdefault(
                "Content-Security-Policy", settings.CONTENT_SECURITY_POLICY
            )
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS "
                "public_key_updated_at TIMESTAMP WITH TIME ZONE"
            )
        )
        await conn.execute(
            text("ALTER TABLE users ADD COLUMN IF NOT EXISTS key_backup TEXT")
        )
        # Phone auth migration (email → phone)
        await conn.execute(
            text("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)")
        )
        # Legacy email column may still exist; relax NOT NULL if present
        await conn.execute(
            text(
                """
                DO $$
                BEGIN
                  IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'users' AND column_name = 'email'
                  ) THEN
                    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
                  END IF;
                END $$;
                """
            )
        )
        await conn.execute(
            text(
                """
                DO $$
                BEGIN
                  IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_key'
                  ) AND NOT EXISTS (
                    SELECT 1 FROM pg_indexes WHERE indexname = 'ix_users_phone'
                  ) THEN
                    CREATE UNIQUE INDEX IF NOT EXISTS ix_users_phone ON users (phone)
                    WHERE phone IS NOT NULL;
                  END IF;
                END $$;
                """
            )
        )
        # Карта офиса: этаж комнаты (таблица star_floors создаётся create_all выше).
        await conn.execute(
            text(
                "ALTER TABLE star_channels ADD COLUMN IF NOT EXISTS floor_id VARCHAR(36) "
                "REFERENCES star_floors(id) ON DELETE SET NULL"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE star_channels ADD COLUMN IF NOT EXISTS access VARCHAR(16) "
                "NOT NULL DEFAULT 'open'"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE star_channels ADD COLUMN IF NOT EXISTS listen_only BOOLEAN "
                "NOT NULL DEFAULT false"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE star_channels ADD COLUMN IF NOT EXISTS cabinet_owner_id VARCHAR(36) "
                "REFERENCES users(id) ON DELETE SET NULL"
            )
        )
    # Кто сейчас на Планетах — восстанавливаем из LiveKit после перезапуска (в фоне).
    app.state.voice_resync = asyncio.create_task(voice.resync())
    yield


app = FastAPI(title="Quazar Messager API", version="0.1.0", lifespan=lifespan)

_cors_origins = settings.cors_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(SecurityHeadersMiddleware)

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(chats_router)
app.include_router(messages_router)
app.include_router(calls_router)
app.include_router(push_router)
app.include_router(stars_router)
app.include_router(star_invites_router)
app.include_router(voice_router)
app.include_router(office_router)
app.include_router(doors_router)
app.include_router(livekit_webhook_router)
app.include_router(stickers_router)
app.include_router(contacts_router)
app.include_router(ws_router)

_media = Path(media_root())
app.mount("/media", StaticFiles(directory=str(_media)), name="media")
app.mount(
    STICKER_FILES_PATH,
    StickerFiles(directory=str(STICKERS_DIR), check_dir=False),
    name="sticker-files",
)

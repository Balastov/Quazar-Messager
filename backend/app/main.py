import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy import text

from app.core.avatars import avatars_dir
from app.core.backgrounds import backgrounds_dir
from app.core.star_assets import stars_media_dir
from app.core import attachments, scheduler, voice
from app.core.config import settings
from app.core.database import AsyncSessionLocal, Base, engine
from app.models import Attachment, Call, PushSubscription, Star  # noqa: F401 — register tables for create_all
from app.api.auth import router as auth_router
from app.api.users import router as users_router
from app.api.chats import router as chats_router
from app.api.messages import router as messages_router
from app.api.later import reminders_router, scheduled_router
from app.api.moderation import router as moderation_router
from app.api.attachments import router as attachments_router
from app.api.calls import router as calls_router
from app.api.push import router as push_router
from app.api.doors import router as doors_router
from app.api.office import router as office_router
from app.api.star_community import router as star_community_router
from app.api.star_play import router as star_play_router
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
        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS "
                "last_seen_at TIMESTAMP WITH TIME ZONE"
            )
        )
        await conn.execute(
            text("ALTER TABLE users ADD COLUMN IF NOT EXISTS manual_status VARCHAR(16)")
        )
        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS "
                "manual_status_until TIMESTAMP WITH TIME ZONE"
            )
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
        await conn.execute(text("ALTER TABLE stars ADD COLUMN IF NOT EXISTS avatar_url TEXT"))
        # Фоны: личный, Звезды, чата.
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS background_url TEXT"))
        await conn.execute(text("ALTER TABLE stars ADD COLUMN IF NOT EXISTS background_url TEXT"))
        await conn.execute(text("ALTER TABLE chats ADD COLUMN IF NOT EXISTS background TEXT"))
        await conn.execute(
            text("ALTER TABLE chats ADD COLUMN IF NOT EXISTS background_attachment_id VARCHAR(36)")
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
        # Ответы и правки сообщений (таблицы реакций и «удалить у меня» — create_all выше).
        await conn.execute(
            text(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id VARCHAR(36) "
                "REFERENCES messages(id) ON DELETE SET NULL"
            )
        )
        await conn.execute(
            text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP WITH TIME ZONE")
        )
        await conn.execute(
            text(
                "ALTER TABLE star_messages ADD COLUMN IF NOT EXISTS reply_to_id VARCHAR(36) "
                "REFERENCES star_messages(id) ON DELETE SET NULL"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE star_messages ADD COLUMN IF NOT EXISTS "
                "edited_at TIMESTAMP WITH TIME ZONE"
            )
        )
    # «Избранное» — новый тип чата. create_all существующий enum не меняет; новое значение
    # нельзя использовать в той же транзакции, где его добавили, — поэтому отдельная транзакция.
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TYPE chat_type ADD VALUE IF NOT EXISTS 'saved'"))
        # Исчезающие сообщения (таблицы отложенных, напоминаний, блокировок — create_all выше).
        await conn.execute(text("ALTER TABLE chats ADD COLUMN IF NOT EXISTS ttl_seconds INTEGER"))
        await conn.execute(
            text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE")
        )
        await conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_messages_expires_at ON messages (expires_at)")
        )
        # Игровые Звёзды: правила и приветствие, фильтр слов, звуковая панель, тайм-ауты,
        # медленный режим, временные Планеты, опросы и сборы (таблицы — create_all выше).
        for ddl in (
            "ALTER TABLE stars ADD COLUMN IF NOT EXISTS rules_text TEXT",
            "ALTER TABLE stars ADD COLUMN IF NOT EXISTS welcome_text TEXT",
            "ALTER TABLE stars ADD COLUMN IF NOT EXISTS welcome_channel_id VARCHAR(36)",
            "ALTER TABLE stars ADD COLUMN IF NOT EXISTS banned_words JSON NOT NULL DEFAULT '[]'",
            "ALTER TABLE stars ADD COLUMN IF NOT EXISTS soundboard BOOLEAN NOT NULL DEFAULT true",
            "ALTER TABLE star_members ADD COLUMN IF NOT EXISTS timeout_until TIMESTAMP WITH TIME ZONE",
            "ALTER TABLE star_members ADD COLUMN IF NOT EXISTS rules_accepted_at TIMESTAMP WITH TIME ZONE",
            "ALTER TABLE star_channels ADD COLUMN IF NOT EXISTS slow_mode_sec INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE star_channels ADD COLUMN IF NOT EXISTS temporary BOOLEAN NOT NULL DEFAULT false",
            "ALTER TABLE star_channels ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) "
            "REFERENCES users(id) ON DELETE SET NULL",
            "ALTER TABLE star_messages ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'text'",
            "ALTER TABLE star_messages ADD COLUMN IF NOT EXISTS ref_id VARCHAR(36)",
        ):
            await conn.execute(text(ddl))
    # Кто сейчас на Планетах — восстанавливаем из LiveKit после перезапуска (в фоне).
    app.state.voice_resync = asyncio.create_task(voice.resync())
    # Неотправленные картинки и файлы удалённых чатов — раз в час.
    app.state.attachments_sweep = asyncio.create_task(
        attachments.sweep_forever(AsyncSessionLocal)
    )
    # Отложенные сообщения, напоминания, исчезающие сообщения — раз в 5 секунд.
    app.state.scheduler = asyncio.create_task(scheduler.run_forever(AsyncSessionLocal))
    yield
    app.state.attachments_sweep.cancel()
    app.state.scheduler.cancel()


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
app.include_router(moderation_router)
app.include_router(users_router)
app.include_router(chats_router)
app.include_router(messages_router)
app.include_router(scheduled_router)
app.include_router(reminders_router)
app.include_router(attachments_router)
app.include_router(calls_router)
app.include_router(push_router)
app.include_router(stars_router)
app.include_router(star_community_router)
app.include_router(star_play_router)
app.include_router(star_invites_router)
app.include_router(voice_router)
app.include_router(office_router)
app.include_router(doors_router)
app.include_router(livekit_webhook_router)
app.include_router(stickers_router)
app.include_router(contacts_router)
app.include_router(ws_router)

# Публично — только аватары и фоны (приложения и Звёзд). Картинки и фоны чатов (MEDIA_ROOT/attachments) отдаёт API участникам.
app.mount("/media/avatars", StaticFiles(directory=str(avatars_dir())), name="media")
app.mount(
    "/media/backgrounds", StaticFiles(directory=str(backgrounds_dir())), name="backgrounds"
)
# Стикеры, эмодзи и звуки Звёзд — публичные, как аватары.
app.mount("/media/stars", StaticFiles(directory=str(stars_media_dir())), name="star-assets")
app.mount(
    STICKER_FILES_PATH,
    StickerFiles(directory=str(STICKERS_DIR), check_dir=False),
    name="sticker-files",
)

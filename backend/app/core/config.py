from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    DATABASE_URL: str = "postgresql+asyncpg://quazar:quazar@localhost:5432/quazar"
    REDIS_URL: str = "redis://localhost:6379"

    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 дней

    # Comma-separated origins. Use "*" only for local/dev.
    CORS_ORIGINS: str = "*"

    # Optional CSP for API responses (empty = do not set).
    CONTENT_SECURITY_POLICY: str = ""

    # Local avatar/media storage (served at /media).
    MEDIA_ROOT: str = "media"
    # Картинки в чатах не загружаются, если на диске останется меньше этого.
    MEDIA_MIN_FREE_MB: int = 2048
    # Сколько дней хранить картинки из чатов (0 — бессрочно). Сообщение остаётся, файл удаляется.
    ATTACHMENT_TTL_DAYS: int = 30

    # WebRTC ICE — comma-separated URLs. TURN strongly recommended for production mobile.
    WEBRTC_STUN_URLS: str = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
    WEBRTC_TURN_URLS: str = ""
    WEBRTC_TURN_USERNAME: str = ""
    WEBRTC_TURN_CREDENTIAL: str = ""

    # Web Push (VAPID). Generate: npx web-push generate-vapid-keys
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    VAPID_SUBJECT: str = "mailto:admin@quazar-msg.ru"

    # Ringing timeout before call becomes missed (seconds)
    CALL_RING_TIMEOUT_SEC: int = 45
    # A participant whose connection dropped mid-call has this long to come back.
    CALL_RECONNECT_GRACE_SEC: int = 10
    # Clients that send heartbeats are treated as gone after this much silence mid-call.
    CALL_HEARTBEAT_TIMEOUT_SEC: int = 6

    # LiveKit — медиасервер голосовых Планет. Пусто = голос на Планетах выключен.
    # LIVEKIT_URL — адрес для бэкенда внутри docker-сети, LIVEKIT_PUBLIC_URL — для браузеров.
    LIVEKIT_URL: str = ""
    LIVEKIT_PUBLIC_URL: str = ""
    LIVEKIT_API_KEY: str = ""
    LIVEKIT_API_SECRET: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        raw = self.CORS_ORIGINS.strip()
        if raw == "*":
            return ["*"]
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    @property
    def webrtc_stun_urls_list(self) -> list[str]:
        return [u.strip() for u in self.WEBRTC_STUN_URLS.split(",") if u.strip()]

    @property
    def webrtc_turn_urls_list(self) -> list[str]:
        return [u.strip() for u in self.WEBRTC_TURN_URLS.split(",") if u.strip()]


settings = Settings()

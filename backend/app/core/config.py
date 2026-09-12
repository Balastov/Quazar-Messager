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

    @property
    def cors_origins_list(self) -> list[str]:
        raw = self.CORS_ORIGINS.strip()
        if raw == "*":
            return ["*"]
        return [origin.strip() for origin in raw.split(",") if origin.strip()]


settings = Settings()

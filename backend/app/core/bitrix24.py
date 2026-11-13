"""Local Bitrix24 app. Never trust submitted DOMAIN, user_id or REST endpoints.

Refresh with our client secret proves the app, OAuth's client_endpoint proves the
portal, and user.current proves the employee. Only then can the launch be used.
"""
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet
from fastapi import HTTPException

from app.core.config import settings

TOKEN_URL = "https://oauth.bitrix24.tech/oauth/token/"
transport: httpx.AsyncBaseTransport | None = None


def origin() -> str:
    raw = settings.BITRIX24_PORTAL_URL.rstrip("/")
    url = urlsplit(raw)
    # This pilot supports one explicitly configured Bitrix cloud portal.
    if (url.scheme != "https" or not url.hostname or
            not re.fullmatch(r"[a-z0-9-]+\.bitrix24\.ru", url.hostname) or
            url.netloc != url.hostname or url.path or url.query or url.fragment):
        raise HTTPException(503, "Неверно настроен адрес портала Б24")
    return raw


def require_enabled() -> None:
    if not all((settings.BITRIX24_PORTAL_URL, settings.BITRIX24_CLIENT_ID,
                settings.BITRIX24_CLIENT_SECRET, settings.BITRIX24_TOKEN_KEY)):
        raise HTTPException(404, "Интеграция Б24 ещё не настроена")
    origin()
    try:
        Fernet(settings.BITRIX24_TOKEN_KEY.encode())
    except (ValueError, TypeError):
        raise HTTPException(503, "Неверно настроен ключ хранения Б24") from None


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def encrypt_tokens(tokens: dict) -> str:
    return Fernet(settings.BITRIX24_TOKEN_KEY.encode()).encrypt(json.dumps(tokens).encode()).decode()


async def _post(url: str, data: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False, trust_env=False,
                                     transport=transport) as client:
            response = await client.post(url, data=data)
        result = response.json()
        if response.status_code != 200 or not isinstance(result, dict) or result.get("error"):
            raise ValueError()
        return result
    except (httpx.HTTPError, ValueError):
        # Upstream descriptions/URLs can contain credentials; don't return them.
        raise HTTPException(502, "Б24 не подтвердил запуск. Откройте приложение из меню портала заново") from None


async def rest(method: str, token: str) -> object:
    if method not in {"user.current", "user.admin", "app.info"}:
        raise ValueError("Unsupported method")
    return (await _post(f"{origin()}/rest/{method}.json", {"auth": token})).get("result")


@dataclass
class VerifiedLaunch:
    member_id: str
    employee_id: str
    display_name: str
    tokens: dict
    expires_at: datetime
    is_admin: bool


async def verify_launch(refresh: str, member_id: str, *, installation: bool) -> VerifiedLaunch:
    tokens = await _post(TOKEN_URL, {
        "grant_type": "refresh_token", "client_id": settings.BITRIX24_CLIENT_ID,
        "client_secret": settings.BITRIX24_CLIENT_SECRET, "refresh_token": refresh,
    })
    employee_id = str(tokens.get("user_id", ""))
    if (tokens.get("member_id") != member_id or not re.fullmatch(r"[1-9]\d{0,18}", employee_id)
            or tokens.get("client_endpoint") != f"{origin()}/rest/"
            or not isinstance(tokens.get("access_token"), str) or not tokens["access_token"]
            or not isinstance(tokens.get("refresh_token"), str) or not tokens["refresh_token"]):
        raise HTTPException(403, "Запуск не относится к подключённому порталу Б24")
    access = tokens["access_token"]
    app = await rest("app.info", access)
    if not isinstance(app, dict) or app.get("CODE") != settings.BITRIX24_CLIENT_ID:
        raise HTTPException(403, "Запуск другого приложения Б24")
    profile = await rest("user.current", access)
    if (not isinstance(profile, dict) or str(profile.get("ID")) != employee_id
            or profile.get("ACTIVE") not in (True, "Y")):
        raise HTTPException(403, "Сотрудник неактивен или недоступен")
    is_admin = (await rest("user.admin", access)) is True if installation else False
    if installation and not is_admin:
        raise HTTPException(403, "Устанавливать Квазар должен администратор Б24")
    try:
        seconds = int(tokens["expires_in"])
        if not 0 < seconds <= 86400:
            raise ValueError()
    except (KeyError, ValueError, TypeError, OverflowError):
        raise HTTPException(502, "Б24 вернул некорректное время авторизации") from None
    name = " ".join(str(profile.get(k) or "").strip() for k in ("NAME", "LAST_NAME")).strip()
    return VerifiedLaunch(member_id, employee_id, name[:160] or "Сотрудник Б24",
                          {"access_token": access, "refresh_token": tokens["refresh_token"]},
                          datetime.now(timezone.utc) + timedelta(seconds=seconds), is_admin)

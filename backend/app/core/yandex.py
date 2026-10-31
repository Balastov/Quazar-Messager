"""Яндекс ID (OAuth 2.0 с PKCE): адрес входа, обмен кода на токен, профиль, аватар.

Документация: https://yandex.ru/dev/id/doc/ru/. Права приложения: login:info, login:email,
login:avatar и (по желанию) login:default_phone — телефон тогда подставится сам.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.core.config import settings

AUTHORIZE_URL = "https://oauth.yandex.ru/authorize"
TOKEN_URL = "https://oauth.yandex.ru/token"
INFO_URL = "https://login.yandex.ru/info"
AVATAR_URL = "https://avatars.yandex.net/get-yapic/{avatar_id}/islands-200"
TIMEOUT = 10.0
MAX_AVATAR = 3 * 1024 * 1024

# Подменяется в тестах.
transport: httpx.AsyncBaseTransport | None = None


class YandexError(Exception):
    """Яндекс не ответил или ответил не так, как ждали — показать «не получилось войти»."""


@dataclass
class Profile:
    id: str
    login: str | None
    email: str | None
    first_name: str | None
    last_name: str | None
    phone: str | None
    avatar_id: str | None


def enabled() -> bool:
    return bool(settings.YANDEX_CLIENT_ID and settings.YANDEX_CLIENT_SECRET)


def redirect_uri() -> str:
    return f"{settings.PUBLIC_URL.rstrip('/')}/api/auth/yandex/callback"


def new_verifier() -> str:
    return secrets.token_urlsafe(64)[:96]


def challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def authorize_url(state: str, verifier: str) -> str:
    params = {
        "response_type": "code",
        "client_id": settings.YANDEX_CLIENT_ID,
        "redirect_uri": redirect_uri(),
        "state": state,
        "code_challenge": challenge(verifier),
        "code_challenge_method": "S256",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT, transport=transport, follow_redirects=False)


async def exchange_code(code: str, verifier: str) -> str:
    """Код из адреса возврата → access_token."""
    try:
        async with _client() as client:
            resp = await client.post(
                TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "code_verifier": verifier,
                    "client_id": settings.YANDEX_CLIENT_ID,
                    "client_secret": settings.YANDEX_CLIENT_SECRET,
                },
            )
    except httpx.HTTPError as exc:
        raise YandexError(f"Яндекс не ответил: {type(exc).__name__}") from None
    if resp.status_code != 200:
        raise YandexError(f"Яндекс не выдал токен ({resp.status_code})")
    token = resp.json().get("access_token")
    if not isinstance(token, str) or not token:
        raise YandexError("В ответе Яндекса нет токена")
    return token


def _str(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


async def fetch_profile(access_token: str) -> Profile:
    try:
        async with _client() as client:
            resp = await client.get(INFO_URL, params={"format": "json"}, headers={"Authorization": f"OAuth {access_token}"})
    except httpx.HTTPError as exc:
        raise YandexError(f"Яндекс не ответил: {type(exc).__name__}") from None
    if resp.status_code != 200:
        raise YandexError(f"Яндекс не отдал профиль ({resp.status_code})")
    data = resp.json()
    subject = data.get("id")
    if not isinstance(subject, (str, int)) or not str(subject):
        raise YandexError("В профиле Яндекса нет id")
    phone = data.get("default_phone")
    return Profile(
        id=str(subject),
        login=_str(data.get("login")),
        email=_str(data.get("default_email")),
        first_name=_str(data.get("first_name")),
        last_name=_str(data.get("last_name")),
        phone=_str(phone.get("number")) if isinstance(phone, dict) else None,
        avatar_id=None if data.get("is_avatar_empty") else _str(data.get("default_avatar_id")),
    )


async def fetch_avatar(avatar_id: str) -> bytes | None:
    """Картинка аватара (до 3 МБ) или None — без неё регистрация не ломается."""
    if not avatar_id.replace("/", "").replace("-", "").replace("_", "").isalnum():
        return None
    try:
        async with _client() as client:
            resp = await client.get(AVATAR_URL.format(avatar_id=avatar_id))
    except httpx.HTTPError:
        return None
    if resp.status_code != 200 or len(resp.content) > MAX_AVATAR:
        return None
    return resp.content

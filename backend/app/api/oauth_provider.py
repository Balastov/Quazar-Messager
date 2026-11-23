"""Квазар как провайдер входа для других сервисов (сейчас — Padma): OAuth 2.0 Authorization Code
с PKCE (S256), один конфиденциальный клиент. OIDC-токены не выдаются — профиль клиент берёт
запросом /oauth/userinfo со своего сервера. Протокол и правила — docs/PADMA-SSO.md.

Путь: страница /oauth/authorize веб-клиента (вход, подтверждение телефона, «Продолжить») →
POST /oauth/authorize выдаёт одноразовый код → сервер клиента меняет его на токен
(POST /oauth/token) → GET /oauth/userinfo.

Код и токен — случайные 32 байта; в базе только SHA-256. Без настроек клиента всё отвечает 404.
"""

import base64
import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.phone_verification import client_ip
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.oauth_provider import OAuthAccessToken, OAuthCode
from app.models.user import User

router = APIRouter(prefix="/oauth", tags=["oauth provider"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

CODE_TTL = timedelta(seconds=120)
TOKEN_TTL = timedelta(minutes=5)
# Просроченные коды и токены удаляем не сразу: по ним видно повторное использование.
KEEP_EXPIRED = timedelta(days=1)
# Обмен кодов на токены с одного адреса за минуту.
TOKEN_RATE = 30
MAX_FORM_BYTES = 8192

_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
# RFC 7636: verifier — 43–128 «незарезервированных» символов.
_VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")

_token_calls: dict[str, deque[float]] = defaultdict(deque)


@dataclass(frozen=True)
class Client:
    id: str
    name: str
    secret: str
    redirect_uris: tuple[str, ...]


def clients() -> dict[str, Client]:
    """Клиенты из настроек. Пока задан только Padma; без id, секрета или адресов возврата — никого."""
    uris = tuple(u.strip() for u in settings.PADMA_OAUTH_REDIRECT_URIS.split(",") if u.strip())
    if not (settings.PADMA_OAUTH_CLIENT_ID and settings.PADMA_OAUTH_CLIENT_SECRET and uris):
        return {}
    client = Client(settings.PADMA_OAUTH_CLIENT_ID, "Padma", settings.PADMA_OAUTH_CLIENT_SECRET, uris)
    return {client.id: client}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _require_enabled() -> dict[str, Client]:
    known = clients()
    if not known:
        raise HTTPException(status_code=404, detail="Not Found")
    return known


def _client(client_id: str, redirect_uri: str) -> Client:
    """Клиент и его адрес возврата — точное совпадение строки (иначе — открытый редирект)."""
    client = _require_enabled().get(client_id)
    if not client or redirect_uri not in client.redirect_uris:
        raise HTTPException(status_code=400, detail="Неизвестное приложение или адрес возврата")
    return client


def _oauth_error(status: int, error: str, **headers: str) -> JSONResponse:
    return JSONResponse({"error": error}, status_code=status, headers={"Cache-Control": "no-store", **headers})


class ClientOut(BaseModel):
    name: str


@router.get("/client", response_model=ClientOut)
async def check_client(client_id: str, redirect_uri: str):
    """Страница авторизации проверяет параметры, прежде чем что-то показать или куда-то вести."""
    return ClientOut(name=_client(client_id, redirect_uri).name)


class AuthorizeIn(BaseModel):
    client_id: str = Field(max_length=64)
    redirect_uri: str = Field(max_length=512)
    state: str = Field(min_length=1, max_length=512)
    code_challenge: str = Field(max_length=128)
    code_challenge_method: str = Field(max_length=8)


class AuthorizeOut(BaseModel):
    redirect_to: str


@router.post("/authorize", response_model=AuthorizeOut)
async def authorize(body: AuthorizeIn, current_user: CurrentUser, db: Db):
    """Человек нажал «Продолжить»: одноразовый код для клиента. state не храним — просто возвращаем."""
    client = _client(body.client_id, body.redirect_uri)
    if body.code_challenge_method != "S256" or not _CHALLENGE.fullmatch(body.code_challenge):
        raise HTTPException(status_code=400, detail="Нужен PKCE: code_challenge (S256, base64url)")
    if not current_user.is_active or current_user.blocked_at or current_user.is_official:
        raise HTTPException(status_code=403, detail="Этот аккаунт не может входить в другие сервисы")
    if not current_user.phone_verified_at:
        raise HTTPException(status_code=403, detail="phone_unverified")
    code = secrets.token_urlsafe(32)
    db.add(OAuthCode(
        code_hash=_hash(code), client_id=client.id, redirect_uri=body.redirect_uri, user_id=current_user.id,
        code_challenge=body.code_challenge, expires_at=_now() + CODE_TTL,
    ))
    await db.commit()
    separator = "&" if urlsplit(body.redirect_uri).query else "?"
    return AuthorizeOut(redirect_to=f"{body.redirect_uri}{separator}{urlencode({'code': code, 'state': body.state})}")


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    calls = _token_calls[ip]
    while calls and now - calls[0] > 60:
        calls.popleft()
    if len(calls) >= TOKEN_RATE:
        return True
    calls.append(now)
    if len(_token_calls) > 10_000:
        for key in [k for k, v in _token_calls.items() if not v or now - v[-1] > 60]:
            _token_calls.pop(key, None)
    return False


def _single(form: dict[str, list[str]], name: str) -> str | None:
    """Параметр формы ровно один раз (повтор — ошибка запроса, RFC 6749 §3.2)."""
    values = form.get(name)
    if values is None:
        return None
    if len(values) != 1:
        raise ValueError(name)
    return values[0]


def _client_matches(client: Client | None, secret: str) -> bool:
    """Секрет — за постоянное время; для неизвестного клиента сравниваем с пустышкой."""
    expected = client.secret if client else secrets.token_urlsafe(32)
    return hmac.compare_digest(secret.encode(), expected.encode()) and client is not None


def _pkce_ok(verifier: str, challenge: str) -> bool:
    if not _VERIFIER.fullmatch(verifier):
        return False
    computed = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return hmac.compare_digest(computed, challenge)


def _can_sign_in(user: User | None) -> bool:
    return bool(user and user.is_active and not user.blocked_at and not user.is_official and user.phone_verified_at)


@router.post("/token")
async def token(request: Request, db: Db):
    """Сервер клиента меняет код на токен (form-urlencoded). Ошибки — в формате OAuth: {"error": …}."""
    known = _require_enabled()
    if _rate_limited(client_ip(request)):
        return _oauth_error(429, "slow_down", **{"Retry-After": "60"})
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/x-www-form-urlencoded":
        return _oauth_error(400, "invalid_request")
    raw = await request.body()
    if len(raw) > MAX_FORM_BYTES:
        return _oauth_error(400, "invalid_request")
    try:
        form = parse_qs(raw.decode(), keep_blank_values=True, strict_parsing=False, max_num_fields=20)
        values = {name: _single(form, name) for name in (
            "grant_type", "code", "redirect_uri", "code_verifier", "client_id", "client_secret")}
    except (UnicodeDecodeError, ValueError):
        return _oauth_error(400, "invalid_request")

    client = known.get(values["client_id"] or "")
    if not _client_matches(client, values["client_secret"] or ""):
        return _oauth_error(401, "invalid_client")
    if values["grant_type"] != "authorization_code":
        return _oauth_error(400, "unsupported_grant_type")
    code, redirect_uri, verifier = values["code"], values["redirect_uri"], values["code_verifier"]
    if not code or not redirect_uri or not verifier:
        return _oauth_error(400, "invalid_request")

    now = _now()
    code_hash = _hash(code)
    # Атомарно: из двух одновременных обменов одного кода пройдёт только один.
    row = (await db.execute(
        update(OAuthCode)
        .where(OAuthCode.code_hash == code_hash, OAuthCode.used_at.is_(None))
        .values(used_at=now)
        .returning(OAuthCode.client_id, OAuthCode.redirect_uri, OAuthCode.user_id,
                   OAuthCode.code_challenge, OAuthCode.expires_at)
    )).first()
    if row is None:
        # Неизвестный или уже обменянный код. Если обменянный — его перехватили: отзываем токен.
        await db.execute(
            update(OAuthAccessToken)
            .where(OAuthAccessToken.code_hash == code_hash, OAuthAccessToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await db.commit()
        return _oauth_error(400, "invalid_grant")
    user = await db.get(User, row.user_id)
    valid = (
        row.client_id == client.id
        and row.redirect_uri == redirect_uri
        and row.expires_at > now
        and _pkce_ok(verifier, row.code_challenge)
        and _can_sign_in(user)
    )
    if not valid:
        await db.commit()  # код всё равно сгорел
        return _oauth_error(400, "invalid_grant")

    access_token = secrets.token_urlsafe(32)
    db.add(OAuthAccessToken(
        token_hash=_hash(access_token), code_hash=code_hash, client_id=client.id, user_id=row.user_id,
        expires_at=now + TOKEN_TTL,
    ))
    await db.execute(delete(OAuthCode).where(OAuthCode.expires_at < now - KEEP_EXPIRED))
    await db.execute(delete(OAuthAccessToken).where(OAuthAccessToken.expires_at < now - KEEP_EXPIRED))
    await db.commit()
    return JSONResponse(
        {"access_token": access_token, "token_type": "Bearer", "expires_in": int(TOKEN_TTL.total_seconds())},
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@router.get("/userinfo")
async def userinfo(request: Request, db: Db):
    """Профиль по токену доступа. Каждый раз заново: активен, не заблокирован, телефон подтверждён."""
    known = _require_enabled()
    invalid = _oauth_error(401, "invalid_token", **{"WWW-Authenticate": 'Bearer error="invalid_token"'})
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return invalid
    row = (await db.execute(
        select(OAuthAccessToken).where(OAuthAccessToken.token_hash == _hash(value.strip()))
    )).scalar_one_or_none()
    if not row or row.revoked_at or row.expires_at <= _now() or row.client_id not in known:
        return invalid
    user = await db.get(User, row.user_id)
    if not _can_sign_in(user):
        return invalid
    return JSONResponse({
        "sub": user.id,
        "phone_number": user.phone,
        "phone_number_verified": True,
        "given_name": user.first_name,
        "family_name": user.last_name,
        "preferred_username": user.username,
    }, headers={"Cache-Control": "no-store"})

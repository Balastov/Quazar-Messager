"""Вход и регистрация через Яндекс ID, привязка к аккаунту, пароль для таких аккаунтов.

Путь: /auth/yandex/start → Яндекс → /auth/yandex/callback → клиент получает одноразовый код
в адресе (#code=…) и меняет его на сессию (/auth/yandex/exchange). Новичку вместо сессии
отдаём данные из Яндекса — он выбирает ник и телефон (/auth/yandex/complete).

Склеивать аккаунты по совпадению телефона или почты нельзя: телефон в Quazar не подтверждается,
так можно было бы войти в чужой аккаунт. Привязать Яндекс к существующему аккаунту — только
войдя в него (/auth/yandex/link).
"""

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, ValidationInfo, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import yandex
from app.core.accounts import TAKEN, email_taken, phone_taken, username_taken
from app.core.avatars import detect_image, save_avatar
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.phone import normalize_ru_phone
from app.core.profile import normalize_email, normalize_person_name, normalize_username
from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import OAuthFlow, User, UserIdentity
from app.schemas.user import NAME_LABELS, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])
me_router = APIRouter(prefix="/users/me", tags=["users"])

CurrentUser = Annotated[User, Depends(get_current_user)]
Db = Annotated[AsyncSession, Depends(get_db)]

STATE_TTL = timedelta(minutes=10)
# Сколько ждём, пока новичок выберет ник и телефон.
REGISTER_TTL = timedelta(minutes=30)
# Подтверждение через Яндекс (аккаунт без пароля задаёт пароль) годится столько.
REAUTH_TTL = timedelta(minutes=5)
MOBILE_RETURN = "quazar://auth/yandex"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _require_enabled() -> None:
    if not yandex.enabled():
        raise HTTPException(status_code=404, detail="Вход через Яндекс не настроен")


def _return_url(client: str, **fragment: str) -> str:
    base = MOBILE_RETURN if client == "mobile" else f"{settings.PUBLIC_URL.rstrip('/')}/auth/yandex"
    return f"{base}#{urlencode(fragment)}"


async def _new_flow(db: AsyncSession, mode: str, client: str, user_id: str | None = None) -> OAuthFlow:
    await db.execute(delete(OAuthFlow).where(OAuthFlow.expires_at < _now()))
    flow = OAuthFlow(
        state=secrets.token_urlsafe(32),
        provider="yandex",
        verifier=yandex.new_verifier(),
        mode=mode,
        client=client,
        user_id=user_id,
        expires_at=_now() + STATE_TTL,
    )
    db.add(flow)
    await db.commit()
    return flow


class ProvidersOut(BaseModel):
    yandex: bool


@router.get("/providers", response_model=ProvidersOut)
async def providers():
    """Какие внешние входы включены — клиент показывает кнопки только для них."""
    return ProvidersOut(yandex=yandex.enabled())


@router.get("/yandex/start")
async def yandex_start(db: Db, client: Literal["web", "mobile"] = "web"):
    """Начать вход: уводим в Яндекс."""
    _require_enabled()
    flow = await _new_flow(db, "login", client)
    return RedirectResponse(yandex.authorize_url(flow.state, flow.verifier), status_code=status.HTTP_302_FOUND)


class LinkStartOut(BaseModel):
    url: str


@router.post("/yandex/link", response_model=LinkStartOut)
async def yandex_link_start(current_user: CurrentUser, db: Db, client: Literal["web", "mobile"] = "web"):
    """Привязать Яндекс к своему аккаунту: адрес, куда перейти (переход — без заголовка авторизации)."""
    _require_enabled()
    flow = await _new_flow(db, "link", client, current_user.id)
    return LinkStartOut(url=yandex.authorize_url(flow.state, flow.verifier))


@router.get("/yandex/callback")
async def yandex_callback(
    db: Db,
    state: str = Query("", max_length=128),
    code: str = Query("", max_length=512),
    error: str = Query("", max_length=128),
):
    """Яндекс вернул человека. Сессию в адрес не кладём — только одноразовый код."""
    flow = await db.get(OAuthFlow, state) if state else None
    if not flow or flow.handoff or flow.expires_at < _now():
        return RedirectResponse(_return_url("web", error="expired"), status_code=status.HTTP_302_FOUND)
    client = flow.client
    if error or not code:
        await db.delete(flow)
        await db.commit()
        return RedirectResponse(_return_url(client, error="denied"), status_code=status.HTTP_302_FOUND)
    try:
        profile = await yandex.fetch_profile(await yandex.exchange_code(code, flow.verifier))
    except yandex.YandexError:
        await db.delete(flow)
        await db.commit()
        return RedirectResponse(_return_url(client, error="yandex"), status_code=status.HTTP_302_FOUND)

    identity = (
        await db.execute(
            select(UserIdentity).where(UserIdentity.provider == "yandex", UserIdentity.subject == profile.id)
        )
    ).scalar_one_or_none()

    if flow.mode == "reauth":
        # Подтвердить можно только тем Яндексом, что привязан к этому аккаунту.
        if not identity or identity.user_id != flow.user_id:
            await db.delete(flow)
            await db.commit()
            return RedirectResponse(_return_url(client, error="mismatch"), status_code=status.HTTP_302_FOUND)
        flow.handoff = secrets.token_urlsafe(32)
        flow.expires_at = _now() + REAUTH_TTL
        await db.commit()
        return RedirectResponse(_return_url(client, reauth=flow.handoff), status_code=status.HTTP_302_FOUND)

    if flow.mode == "link":
        result = await _link(db, flow, identity, profile)
        await db.delete(flow)
        await db.commit()
        return RedirectResponse(_return_url(client, linked=result), status_code=status.HTTP_302_FOUND)

    flow.handoff = secrets.token_urlsafe(32)
    if identity:
        flow.user_id = identity.user_id
        flow.expires_at = _now() + STATE_TTL
    else:
        flow.profile = profile.__dict__
        flow.expires_at = _now() + REGISTER_TTL
    await db.commit()
    return RedirectResponse(_return_url(client, code=flow.handoff), status_code=status.HTTP_302_FOUND)


async def _link(db: AsyncSession, flow: OAuthFlow, identity: UserIdentity | None, profile: yandex.Profile) -> str:
    if identity:
        return "ok" if identity.user_id == flow.user_id else "taken"
    existing = (
        await db.execute(
            select(UserIdentity).where(UserIdentity.user_id == flow.user_id, UserIdentity.provider == "yandex")
        )
    ).scalar_one_or_none()
    if existing:
        return "other"
    db.add(
        UserIdentity(user_id=flow.user_id, provider="yandex", subject=profile.id, email=profile.email, login=profile.login)
    )
    return "ok"


@router.post("/yandex/reauth", response_model=LinkStartOut)
async def yandex_reauth_start(current_user: CurrentUser, db: Db, client: Literal["web", "mobile"] = "web"):
    """Подтвердить себя через Яндекс — для аккаунтов без пароля перед важными действиями
    (задать пароль): одной украденной сессии для них мало."""
    _require_enabled()
    flow = await _new_flow(db, "reauth", client, current_user.id)
    return LinkStartOut(url=yandex.authorize_url(flow.state, flow.verifier))


async def consume_reauth(db: AsyncSession, user_id: str, code: str | None) -> bool:
    """Одноразовый код подтверждения через Яндекс для этого человека (и сразу погасить)."""
    if not code:
        return False
    flow = (
        await db.execute(select(OAuthFlow).where(OAuthFlow.handoff == code, OAuthFlow.mode == "reauth"))
    ).scalar_one_or_none()
    if not flow or flow.user_id != user_id or flow.expires_at < _now():
        return False
    await db.delete(flow)
    return True


class ExchangeBody(BaseModel):
    code: str = Field(min_length=1, max_length=128)


class SuggestedProfile(BaseModel):
    username: str | None
    phone: str | None
    email: str | None
    first_name: str | None
    last_name: str | None
    has_avatar: bool


class ExchangeOut(BaseModel):
    # login — вот сессия; register — новичок, покажите шаг «Почти готово».
    status: Literal["login", "register"]
    access_token: str | None = None
    profile: SuggestedProfile | None = None


async def _flow_by_handoff(db: AsyncSession, code: str) -> OAuthFlow:
    flow = (
        await db.execute(select(OAuthFlow).where(OAuthFlow.handoff == code, OAuthFlow.mode == "login"))
    ).scalar_one_or_none()
    if not flow or flow.expires_at < _now():
        raise HTTPException(status_code=410, detail="Время входа истекло — начните заново")
    return flow


_LOGIN_JUNK = re.compile(r"[^a-z0-9_]+")


async def _suggest_username(db: AsyncSession, login: str | None) -> str | None:
    """Ник из логина Яндекса: латиница, цифры, «_»; занят — с цифрой в конце; не годится — None."""
    if not login:
        return None
    base = _LOGIN_JUNK.sub("_", login.lower()).strip("_")[:28]
    for suffix in ("", *map(str, range(2, 30))):
        candidate = f"{base}{suffix}"
        try:
            candidate = normalize_username(candidate)
        except ValueError:
            return None
        if not await username_taken(db, candidate):
            return candidate
    return None


def _clean(fn, value: str | None, *args) -> str | None:
    """Значение из Яндекса, если оно проходит наши правила (формат, цензура); иначе — пусто."""
    try:
        return fn(value, *args) if value else None
    except ValueError:
        return None


@router.post("/yandex/exchange", response_model=ExchangeOut)
async def yandex_exchange(body: ExchangeBody, db: Db):
    flow = await _flow_by_handoff(db, body.code)
    if flow.user_id:
        user = await db.get(User, flow.user_id)
        await db.delete(flow)
        await db.commit()
        if not user:
            raise HTTPException(status_code=410, detail="Аккаунт не найден")
        if user.blocked_at:
            raise HTTPException(status_code=403, detail="Аккаунт заблокирован администрацией")
        return ExchangeOut(status="login", access_token=create_access_token(user.id))
    p = flow.profile or {}
    phone = _clean(normalize_ru_phone, p.get("phone"))
    email = _clean(normalize_email, p.get("email"))
    return ExchangeOut(
        status="register",
        profile=SuggestedProfile(
            username=await _suggest_username(db, p.get("login")),
            phone=phone if phone and not await phone_taken(db, phone) else None,
            email=email if email and not await email_taken(db, email) else None,
            first_name=_clean(normalize_person_name, p.get("first_name"), NAME_LABELS["first_name"]),
            last_name=_clean(normalize_person_name, p.get("last_name"), NAME_LABELS["last_name"]),
            has_avatar=bool(p.get("avatar_id")),
        ),
    )


class CompleteBody(BaseModel):
    code: str = Field(min_length=1, max_length=128)
    username: str
    phone: str
    phone_discoverable: bool
    first_name: str | None = None
    last_name: str | None = None

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        return normalize_username(v)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_ru_phone(v)

    @field_validator("first_name", "last_name")
    @classmethod
    def _name(cls, v: str | None, info: ValidationInfo) -> str | None:
        return normalize_person_name(v, NAME_LABELS[info.field_name])


@router.post("/yandex/complete", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def yandex_complete(body: CompleteBody, db: Db):
    """Новичок выбрал ник и телефон — создаём аккаунт без пароля, с привязанным Яндексом."""
    flow = await _flow_by_handoff(db, body.code)
    if flow.user_id or not flow.profile:
        raise HTTPException(status_code=410, detail="Время входа истекло — начните заново")
    p = flow.profile
    if await phone_taken(db, body.phone):
        raise HTTPException(status_code=400, detail=TAKEN["phone"])
    if await username_taken(db, body.username):
        raise HTTPException(status_code=400, detail=TAKEN["username"])
    email = _clean(normalize_email, p.get("email"))
    if email and await email_taken(db, email):
        email = None
    user = User(
        username=body.username,
        phone=body.phone,
        email=email,
        first_name=body.first_name,
        last_name=body.last_name,
        phone_discoverable=body.phone_discoverable,
        password_hash=None,
    )
    db.add(user)
    try:
        await db.flush()
        db.add(
            UserIdentity(
                user_id=user.id, provider="yandex", subject=p["id"], email=p.get("email"), login=p.get("login")
            )
        )
        await db.delete(flow)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Номер, никнейм или этот Яндекс уже заняты") from None
    if p.get("avatar_id"):
        data = await yandex.fetch_avatar(p["avatar_id"])
        detected = detect_image(data) if data else None
        if detected:
            user.avatar_url = save_avatar(user.id, data, detected[1])
            await db.commit()
    return TokenResponse(access_token=create_access_token(user.id))


# --- Мои входы и пароль -------------------------------------------------------------


class IdentityOut(BaseModel):
    provider: str
    email: str | None
    login: str | None
    created_at: datetime


class SignInOut(BaseModel):
    has_password: bool
    identities: list[IdentityOut]
    providers: ProvidersOut


@me_router.get("/sign-in", response_model=SignInOut)
async def my_sign_in(current_user: CurrentUser, db: Db):
    """Как можно войти в аккаунт: пароль и привязанные внешние входы."""
    rows = await db.execute(select(UserIdentity).where(UserIdentity.user_id == current_user.id))
    user = await db.get(User, current_user.id)
    return SignInOut(
        has_password=bool(user.password_hash),
        identities=[
            IdentityOut(provider=i.provider, email=i.email, login=i.login, created_at=i.created_at)
            for i in rows.scalars()
        ],
        providers=ProvidersOut(yandex=yandex.enabled()),
    )


@me_router.delete("/identities/{provider}", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_identity(provider: str, current_user: CurrentUser, db: Db):
    """Отвязать внешний вход — только если останется другой способ войти."""
    identities = (
        await db.execute(select(UserIdentity).where(UserIdentity.user_id == current_user.id))
    ).scalars().all()
    target = next((i for i in identities if i.provider == provider), None)
    if not target:
        raise HTTPException(status_code=404, detail="Этот вход не привязан")
    user = await db.get(User, current_user.id)
    if not user.password_hash and len(identities) == 1:
        raise HTTPException(status_code=409, detail="Сначала задайте пароль — иначе войти будет нечем")
    await db.delete(target)
    await db.commit()


class PasswordBody(BaseModel):
    # Нужен, если пароль уже есть.
    current_password: str | None = None
    # Пароля ещё нет (аккаунт через Яндекс) — код подтверждения через Яндекс (/auth/yandex/reauth).
    reauth_code: str | None = None
    new_password: str = Field(min_length=8, max_length=128)


@me_router.put("/password", status_code=status.HTTP_204_NO_CONTENT)
async def set_password(body: PasswordBody, current_user: CurrentUser, db: Db):
    """Задать пароль (аккаунт через Яндекс) или сменить его (нужен текущий)."""
    user = await db.get(User, current_user.id)
    if user.password_hash:
        if not verify_password(body.current_password or "", user.password_hash):
            raise HTTPException(status_code=401, detail="Неверный текущий пароль")
    elif not await consume_reauth(db, user.id, body.reauth_code):
        raise HTTPException(status_code=403, detail="Подтвердите, что это вы, через Яндекс ID")
    user.password_hash = hash_password(body.new_password)
    await db.commit()

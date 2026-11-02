from datetime import datetime
from ipaddress import ip_address
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core import phone_verification as verification
from app.core.accounts import phone_taken, TAKEN
from app.core.database import get_db
from app.core.config import settings
from app.core.deps import get_current_user
from app.core.phone import normalize_ru_phone
from app.models.user import User
from app.models.phone_verification import PhoneVerification
from app.core.security import create_access_token
from app.core.passwords import close_sessions
from app.schemas.user import TokenResponse

router = APIRouter(tags=["phone verification"])
Db = Annotated[AsyncSession, Depends(get_db)]
Me = Annotated[User, Depends(get_current_user)]


class StartBody(BaseModel):
    phone: str = Field(max_length=64)

    @field_validator("phone")
    @classmethod
    def phone_valid(cls, value):
        return normalize_ru_phone(value)


class StatusBody(BaseModel):
    verification_token: str = Field(min_length=32, max_length=128)


class VerificationOut(BaseModel):
    state: str
    phone: str
    call_phone: str | None
    expires_at: datetime
    verification_token: str | None = None
    access_token: str | None = None


def output(attempt, state=None, token=None):
    return VerificationOut(state=state or attempt.state, phone=attempt.phone, call_phone=attempt.call_phone,
        expires_at=attempt.expires_at, verification_token=token)


def client_ip(request):
    if settings.TRUST_PROXY_REAL_IP:
        try:
            return str(ip_address(request.headers.get("x-real-ip", "")))
        except ValueError:
            pass
    return request.client.host if request.client else "unknown"


@router.post("/auth/phone-verification/start", response_model=VerificationOut)
async def start_registration(body: StartBody, request: Request, db: Db):
    if await phone_taken(db, body.phone):
        raise HTTPException(status_code=400, detail=TAKEN["phone"])
    attempt, token = await verification.start(db, body.phone, client_ip(request))
    return output(attempt, token=token)


@router.post("/auth/phone-verification/status", response_model=VerificationOut)
async def registration_status(body: StatusBody, db: Db):
    attempt, state = await verification.status(db, body.verification_token)
    return output(attempt, state)


@router.post("/users/me/phone-verification/start", response_model=VerificationOut)
async def start_account(request: Request, me: Me, db: Db):
    attempt, token = await verification.start(db, me.phone, client_ip(request), me.id)
    return output(attempt, token=token)


@router.post("/users/me/phone-verification/status", response_model=VerificationOut)
async def account_status(body: StatusBody, me: Me, db: Db):
    was_verified = bool(me.phone_verified_at)
    attempt, state = await verification.status(db, body.verification_token, me.id)
    result = output(attempt, state)
    if state == "verified" and not was_verified:
        result.access_token = create_access_token(me.id)
        await close_sessions(me.id)
    return result


@router.post("/auth/phone-login/start", response_model=VerificationOut)
async def start_login(body: StartBody, request: Request, db: Db):
    user = (await db.execute(select(User).where(User.phone == body.phone))).scalar_one_or_none()
    if not user or user.is_official or not user.is_active or user.blocked_at:
        raise HTTPException(status_code=400, detail="Не удалось войти по этому номеру. Проверьте номер или создайте аккаунт")
    if not user.phone_verified_at:
        raise HTTPException(status_code=403, detail="Сначала войдите паролем или через привязанный Яндекс ID и подтвердите телефон")
    attempt, token = await verification.start(db, user.phone, client_ip(request), user.id, purpose="login")
    return output(attempt, token=token)


@router.post("/auth/phone-login/options")
async def login_options(body: StartBody, db: Db):
    user = (await db.execute(select(User).where(User.phone == body.phone))).scalar_one_or_none()
    return {"password_login_allowed": bool(user and user.password_login_allowed and user.is_active and not user.blocked_at and not user.is_official)}


@router.post("/auth/phone-login/status", response_model=VerificationOut)
async def login_status(body: StatusBody, db: Db):
    attempt, state = await verification.status(db, body.verification_token, purpose="login")
    return output(attempt, state)


@router.post("/auth/phone-login/complete", response_model=TokenResponse)
async def complete_login(body: StatusBody, db: Db):
    attempt = (await db.execute(select(PhoneVerification).where(
        PhoneVerification.token_hash == verification.digest(body.verification_token), PhoneVerification.purpose == "login"))).scalar_one_or_none()
    if not attempt:
        raise HTTPException(status_code=400, detail="Начните вход заново")
    user = (await db.execute(select(User).where(User.id == attempt.user_id).with_for_update()
        .execution_options(populate_existing=True))).scalar_one_or_none()
    if not user or not user.phone_verified_at or user.blocked_at or not user.is_active or user.is_official:
        raise HTTPException(status_code=403, detail="Вход недоступен")
    await verification.consume(db, user.phone, body.verification_token, purpose="login", user_id=user.id)
    await db.commit()
    return TokenResponse(access_token=create_access_token(user.id))


@router.post("/users/me/phone-reauth/start", response_model=VerificationOut)
async def start_reauth(request: Request, me: Me, db: Db):
    if not me.phone_verified_at:
        raise HTTPException(status_code=403, detail="Сначала подтвердите телефон аккаунта")
    attempt, token = await verification.start(db, me.phone, client_ip(request), me.id, purpose="reauth")
    return output(attempt, token=token)


@router.post("/users/me/phone-reauth/status", response_model=VerificationOut)
async def reauth_status(body: StatusBody, me: Me, db: Db):
    attempt, state = await verification.status(db, body.verification_token, me.id, purpose="reauth")
    return output(attempt, state)

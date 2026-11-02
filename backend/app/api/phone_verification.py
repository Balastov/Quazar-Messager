from datetime import datetime
from ipaddress import ip_address
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import phone_verification as verification
from app.core.accounts import phone_taken, TAKEN
from app.core.database import get_db
from app.core.config import settings
from app.core.deps import get_current_user
from app.core.phone import normalize_ru_phone
from app.models.user import User

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
    attempt, state = await verification.status(db, body.verification_token, me.id)
    return output(attempt, state)

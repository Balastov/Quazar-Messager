from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.device_pairing import client_ip
from app.core import device_sessions as sessions, login_codes
from app.core.database import get_db
from app.core.phone import normalize_ru_phone
from app.schemas.user import TokenResponse


def no_cache(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/auth/code-login", tags=["auth"], dependencies=[Depends(no_cache)])
Db = Annotated[AsyncSession, Depends(get_db)]


class StartBody(BaseModel):
    phone: str = Field(max_length=64)

    @field_validator("phone")
    @classmethod
    def phone_valid(cls, value):
        return normalize_ru_phone(value)


class StartOut(BaseModel):
    login_token: str
    expires_at: datetime
    resend_at: datetime


class CompleteBody(BaseModel):
    login_token: str = Field(min_length=32, max_length=128)
    code: str = Field(max_length=16)

    @field_validator("code")
    @classmethod
    def five_digits(cls, value: str):
        value = "".join(ch for ch in value if not ch.isspace() and ch != "-")
        if len(value) != 5 or not value.isascii() or not value.isdigit():
            raise ValueError("Код — 5 цифр")
        return value


@router.post("/start", response_model=StartOut)
async def start(body: StartBody, request: Request, db: Db):
    """Бот присылает код на устройства, где человек уже вошёл."""
    device = sessions.device_name(request.headers.get("user-agent", "")[:1024])
    row, token = await login_codes.start(db, body.phone, client_ip(request), device)
    return StartOut(login_token=token, expires_at=row.expires_at, resend_at=row.created_at + login_codes.RESEND_AFTER)


@router.post("/complete", response_model=TokenResponse)
async def complete(body: CompleteBody, request: Request, db: Db):
    token = await login_codes.complete(db, body.login_token, body.code, client_ip(request))
    return TokenResponse(access_token=token)

from datetime import datetime
import base64
import ipaddress
import secrets
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import device_pairing as pairing, device_sessions as sessions
from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.security import create_access_token, token_claims
from app.models.device import DevicePairing, DeviceSession
from app.models.user import User
from app.ws.hub import manager


def no_cache(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/auth", tags=["devices"], dependencies=[Depends(no_cache)])
Db = Annotated[AsyncSession, Depends(get_db)]
Me = Annotated[User, Depends(get_current_user)]


async def current_session(request: Request, me: Me, db: Db) -> DeviceSession:
    row = await db.get(DeviceSession, getattr(request.state, "device_session_id", None))
    if not row or row.user_id != me.id or row.revoked_at:
        raise HTTPException(status_code=401, detail="Сессия завершена")
    return row


CurrentDevice = Annotated[DeviceSession, Depends(current_session)]


def client_ip(request: Request) -> str:
    if settings.TRUST_PROXY_REAL_IP:
        try:
            return str(ipaddress.ip_address(request.headers.get("x-real-ip", "")))
        except ValueError:
            pass
    return request.client.host if request.client else "unknown"


class KeyBody(BaseModel):
    public_key: str = Field(min_length=44, max_length=44)
    @field_validator("public_key")
    @classmethod
    def key(cls, value: str):
        return pairing.validate_key(value)


class ReceiverBody(KeyBody):
    receiver_secret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    device_name: str = Field(min_length=1, max_length=160)
    @field_validator("device_name")
    @classmethod
    def name(cls, value: str):
        value = value.strip()
        if not value or any(ord(ch) < 32 or ch in "\u2028\u2029" for ch in value):
            raise ValueError("Укажите название устройства одной строкой")
        return value


class InviteAccept(ReceiverBody):
    invite_secret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    expected_key: str = Field(min_length=44, max_length=44)


class ClaimBody(KeyBody):
    request_id: str | None = Field(default=None, min_length=36, max_length=36)
    code: str | None = Field(default=None, min_length=8, max_length=20)
    expected_key: str | None = Field(default=None, min_length=44, max_length=44)
    @model_validator(mode="after")
    def handle(self):
        if bool(self.request_id) == bool(self.code):
            raise ValueError("Укажите QR-запрос или одноразовый код")
        if self.request_id and not self.expected_key:
            raise ValueError("QR-запрос должен содержать ключ устройства")
        return self


class SecretBody(BaseModel):
    receiver_secret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class EncryptedKeys(BaseModel):
    nonce: str = Field(min_length=32, max_length=32)
    ciphertext: str = Field(min_length=24, max_length=100_000)
    @model_validator(mode="after")
    def encodings(self):
        try:
            if len(base64.b64decode(self.nonce, validate=True)) != 24 or len(base64.b64decode(self.ciphertext, validate=True)) < 16:
                raise ValueError()
        except ValueError:
            raise ValueError("Некорректный зашифрованный пакет ключей") from None
        return self


class ApproveBody(BaseModel):
    confirmed: Literal[True]
    binding: str = Field(pattern=r"^[0-9a-f]{64}$")
    encrypted_keys: EncryptedKeys | None = None
    allow_without_keys: bool = False


class PairAccount(BaseModel):
    id: str
    username: str
    display_name: str
    avatar_url: str | None


class PairView(BaseModel):
    id: str
    kind: str
    state: str
    receiver_public_key: str | None
    approver_public_key: str | None
    account_public_key: str | None
    account: PairAccount | None
    device_name: str
    created_at: datetime
    expires_at: datetime
    transferred_keys: bool


async def view(db: AsyncSession, row: DevicePairing) -> PairView:
    user = await db.get(User, row.user_id) if row.user_id else None
    state = "expired" if row.expires_at <= pairing.now() and row.state not in ("consumed", "rejected") else row.state
    return PairView(id=row.id, kind=row.kind, state=state, receiver_public_key=row.receiver_public_key,
        approver_public_key=row.approver_public_key, account_public_key=row.account_public_key,
        account=PairAccount(id=user.id, username=user.username, display_name=user.display_name, avatar_url=user.avatar_url) if user else None,
        device_name=row.device_name, created_at=row.created_at, expires_at=row.expires_at, transferred_keys=bool(row.encrypted_keys))


@router.post("/device-pairing/requests")
async def start_request(body: ReceiverBody, request: Request, db: Db):
    await pairing.rate_limit(db, "request", client_ip(request))
    row, code = await pairing.start_request(db, body.public_key, body.receiver_secret, body.device_name)
    return {"request": await view(db, row), "code": code}


async def key_request_closed(row: DevicePairing) -> None:
    """Запрос ключей занят другим устройством или отменён — остальные убирают предложение."""
    if row.kind == "keys" and row.user_id:
        await manager.send_to_user(row.user_id, {"type": "device_key_request_closed", "id": row.id})


@router.post("/device-pairing/key-requests")
async def start_key_request(body: ReceiverBody, me: Me, device: CurrentDevice, db: Db):
    await pairing.rate_limit(db, "keys", me.id)
    row, code = await pairing.start_key_request(db, me.id, device.id, body.public_key, body.receiver_secret, body.device_name)
    # Другие открытые устройства сразу предложат передать ключ. Код сравнения всё равно сверяют глазами.
    await manager.send_to_user(me.id, {"type": "device_key_request", "id": row.id, "receiver_public_key": row.receiver_public_key,
        "device_name": row.device_name, "expires_at": row.expires_at.isoformat()})
    return {"request": await view(db, row), "code": code}


@router.post("/device-pairing/key-requests/{pair_id}/consume")
async def consume_keys(pair_id: str, body: SecretBody, me: Me, device: CurrentDevice, db: Db):
    row = await pairing.consume_keys(db, pair_id, body.receiver_secret, me.id, device.id)
    return {"request": await view(db, row), "encrypted_keys": row.encrypted_keys}


@router.post("/device-pairing/invitations")
async def create_invite(body: KeyBody, request: Request, me: Me, device: CurrentDevice, db: Db):
    await pairing.rate_limit(db, "invite", me.id)
    row, secret = await pairing.create_invite(db, me.id, device.id, body.public_key)
    return {"request": await view(db, row), "invite_secret": secret}


@router.post("/device-pairing/invitations/{pair_id}/accept", response_model=PairView)
async def accept_invite(pair_id: str, body: InviteAccept, request: Request, db: Db):
    await pairing.rate_limit(db, "invite-accept", client_ip(request))
    row = await pairing.accept_invite(db, pair_id, body.invite_secret, body.expected_key, body.public_key, body.receiver_secret, body.device_name)
    return await view(db, row)


@router.post("/device-pairing/claim", response_model=PairView)
async def claim(body: ClaimBody, me: Me, device: CurrentDevice, db: Db):
    await pairing.rate_limit(db, "claim", me.id)
    row = await pairing.claim(db, me.id, device.id, body.public_key, pair_id=body.request_id, code=body.code, expected_key=body.expected_key)
    await key_request_closed(row)
    return await view(db, row)


@router.post("/device-pairing/requests/{pair_id}/status", response_model=PairView)
async def status(pair_id: str, body: SecretBody, db: Db):
    row = await pairing.get_pair(db, pair_id)
    pairing.receiver(row, body.receiver_secret)
    return await view(db, row)


@router.get("/device-pairing/owned/{pair_id}", response_model=PairView)
async def owned(pair_id: str, me: Me, device: CurrentDevice, db: Db):
    row = await pairing.get_pair(db, pair_id)
    if row.user_id != me.id or row.approver_session_id != device.id:
        raise HTTPException(status_code=404, detail="Запрос подключения не найден")
    return await view(db, row)


@router.post("/device-pairing/requests/{pair_id}/approve", response_model=PairView)
async def approve(pair_id: str, body: ApproveBody, me: Me, device: CurrentDevice, db: Db):
    row = await pairing.approve(db, pair_id, me.id, device.id, body.binding,
        body.encrypted_keys.model_dump() if body.encrypted_keys else None, body.allow_without_keys)
    return await view(db, row)


@router.post("/device-pairing/requests/{pair_id}/consume")
async def consume(pair_id: str, body: SecretBody, db: Db):
    row, token = await pairing.consume(db, pair_id, body.receiver_secret)
    return {"request": await view(db, row), "access_token": token, "encrypted_keys": row.encrypted_keys}


@router.post("/device-pairing/requests/{pair_id}/cancel", status_code=204)
async def cancel(pair_id: str, body: SecretBody, db: Db):
    row = await pairing.get_pair(db, pair_id, lock=True)
    pairing.receiver(row, body.receiver_secret)
    if row.state == "consumed":
        raise HTTPException(status_code=409, detail="Устройство уже подключено. Завершите его сессию в настройках")
    row.state, row.encrypted_keys = "rejected", None
    await db.commit()
    await key_request_closed(row)


@router.post("/device-pairing/owned/{pair_id}/reject", status_code=204)
async def reject(pair_id: str, me: Me, device: CurrentDevice, db: Db):
    row = await pairing.get_pair(db, pair_id, lock=True)
    if row.user_id != me.id or row.approver_session_id != device.id:
        raise HTTPException(status_code=404, detail="Запрос подключения не найден")
    if row.state == "consumed":
        raise HTTPException(status_code=409, detail="Устройство уже подключено. Завершите его сессию в настройках")
    row.state, row.encrypted_keys = "rejected", None
    await db.commit()


class SessionOut(BaseModel):
    id: str
    name: str
    current: bool
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime


@router.get("/devices", response_model=list[SessionOut])
async def list_devices(me: Me, device: CurrentDevice, db: Db):
    query = select(DeviceSession).where(DeviceSession.user_id == me.id, DeviceSession.revoked_at.is_(None), DeviceSession.expires_at > sessions.now())
    if sessions.cutoff(me):
        query = query.where(DeviceSession.issued_at >= sessions.cutoff(me))
    rows = (await db.execute(query.order_by(DeviceSession.last_seen_at.desc()))).scalars()
    return [SessionOut(id=row.id, name=row.name, current=row.id == device.id, created_at=row.created_at, last_seen_at=row.last_seen_at, expires_at=row.expires_at) for row in rows]


@router.delete("/devices/current", status_code=204)
async def logout_current(me: Me, device: CurrentDevice, db: Db):
    device.revoked_at = sessions.now()
    await db.commit()
    await sessions.close_connections(me.id, device.id)


@router.delete("/devices/others")
async def revoke_others(me: Me, device: CurrentDevice, db: Db):
    user, row = await pairing.source(db, me.id, device.id)
    user.sessions_revoked_at = sessions.now()
    await db.execute(update(DeviceSession).where(DeviceSession.user_id == user.id, DeviceSession.id != row.id, DeviceSession.revoked_at.is_(None)).values(revoked_at=sessions.now()))
    row.issued_at, row.token_jti = sessions.now(), secrets.token_urlsafe(24)
    token = create_access_token(user.id, row.id, issued_at=row.issued_at, expires_at=row.expires_at, jti=row.token_jti)
    row.token_hash = sessions.digest(token)
    await db.commit()
    await sessions.close_connections(user.id, except_id=row.id)
    return {"access_token": token}


@router.delete("/devices/{session_id}", status_code=204)
async def revoke(session_id: str, me: Me, device: CurrentDevice, db: Db):
    row = (await db.execute(select(DeviceSession).where(DeviceSession.id == session_id, DeviceSession.user_id == me.id).with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    row.revoked_at = sessions.now()
    await db.commit()
    await sessions.close_connections(me.id, row.id)

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.e2e import decode_public_key_b64
from app.core.e2e_users import get_direct_chat_partner_ids
from app.models.user import User
from app.schemas.user import UserOut
from app.ws.hub import manager

router = APIRouter(prefix="/users", tags=["users"])


class UploadKeyBody(BaseModel):
    public_key: str  # base64-encoded X25519 public key (32 bytes)
    force: bool = False


class PublicKeyOut(BaseModel):
    user_id: str
    public_key: str | None
    public_key_updated_at: datetime | None = None


@router.get("/me", response_model=UserOut)
async def get_me(current_user: Annotated[User, Depends(get_current_user)]):
    return current_user


@router.put("/me/key", response_model=PublicKeyOut)
async def upload_public_key(
    body: UploadKeyBody,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Загружает публичный X25519-ключ пользователя (используется для E2E шифрования)."""
    try:
        decode_public_key_b64(body.public_key)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if (
        current_user.public_key
        and current_user.public_key != body.public_key
        and not body.force
    ):
        raise HTTPException(
            status_code=409,
            detail="Public key already set. Use force=true to rotate.",
        )

    key_changed = (
        current_user.public_key is not None and current_user.public_key != body.public_key
    )

    current_user.public_key = body.public_key
    if key_changed:
        current_user.public_key_updated_at = datetime.now(timezone.utc)
    elif current_user.public_key_updated_at is None:
        current_user.public_key_updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(current_user)

    if key_changed:
        partner_ids = await get_direct_chat_partner_ids(current_user.id, db)
        await manager.broadcast_to_users(
            partner_ids,
            {
                "type": "key_changed",
                "user_id": current_user.id,
                "public_key": current_user.public_key,
                "updated_at": current_user.public_key_updated_at.isoformat(),
            },
        )

    return PublicKeyOut(
        user_id=current_user.id,
        public_key=current_user.public_key,
        public_key_updated_at=current_user.public_key_updated_at,
    )


@router.get("/{user_id}/key", response_model=PublicKeyOut)
async def get_public_key(
    user_id: str,
    _: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Возвращает публичный ключ пользователя для установки E2E-сессии."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return PublicKeyOut(
        user_id=user.id,
        public_key=user.public_key,
        public_key_updated_at=user.public_key_updated_at,
    )


@router.get("/search", response_model=list[UserOut])
async def search_users(
    q: Annotated[str, Query(min_length=2)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(User)
        .where(User.username.ilike(f"%{q}%"), User.id != current_user.id)
        .limit(20)
    )
    return result.scalars().all()

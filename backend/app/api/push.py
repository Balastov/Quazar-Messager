from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.push import push_configured
from app.models.push import PushSubscription
from app.models.user import User

router = APIRouter(prefix="/push", tags=["push"])


class VapidPublicOut(BaseModel):
    publicKey: str | None
    configured: bool


class PushKeysIn(BaseModel):
    p256dh: str
    auth: str


class PushSubscribeIn(BaseModel):
    endpoint: str = Field(min_length=8, max_length=2048)
    keys: PushKeysIn
    user_agent: str | None = Field(default=None, max_length=512)


class PushUnsubscribeIn(BaseModel):
    endpoint: str = Field(min_length=8, max_length=2048)


@router.get("/vapid-public-key", response_model=VapidPublicOut)
async def vapid_public_key():
    if not push_configured():
        return VapidPublicOut(publicKey=None, configured=False)
    return VapidPublicOut(publicKey=settings.VAPID_PUBLIC_KEY.strip(), configured=True)


@router.post("/subscribe")
async def subscribe(
    body: PushSubscribeIn,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if not push_configured():
        raise HTTPException(status_code=503, detail="Web Push is not configured on the server")

    result = await db.execute(
        select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)
    )
    row = result.scalar_one_or_none()
    if row:
        row.user_id = current_user.id
        row.p256dh = body.keys.p256dh
        row.auth = body.keys.auth
        row.user_agent = body.user_agent
    else:
        db.add(
            PushSubscription(
                user_id=current_user.id,
                endpoint=body.endpoint,
                p256dh=body.keys.p256dh,
                auth=body.keys.auth,
                user_agent=body.user_agent,
            )
        )
    await db.commit()
    return {"ok": True}


@router.delete("/subscribe")
async def unsubscribe(
    body: PushUnsubscribeIn,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(PushSubscription).where(
            PushSubscription.endpoint == body.endpoint,
            PushSubscription.user_id == current_user.id,
        )
    )
    row = result.scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}

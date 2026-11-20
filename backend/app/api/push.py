from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core import fcm
from app.core.push import push_configured
from app.models.push import FcmDevice, PushSubscription
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
    enabled: bool = True
    sound: bool = True


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
        if row.user_id != current_user.id:
            row.recent_message_ids = []
        row.user_id = current_user.id
        row.p256dh = body.keys.p256dh
        row.auth = body.keys.auth
        row.user_agent = body.user_agent
        row.enabled, row.sound = body.enabled, body.sound
    else:
        db.add(
            PushSubscription(
                user_id=current_user.id,
                endpoint=body.endpoint,
                p256dh=body.keys.p256dh,
                auth=body.keys.auth,
                user_agent=body.user_agent,
                enabled=body.enabled,
                sound=body.sound,
            )
        )
    await db.commit()
    return {"ok": True}


class PushAckIn(BaseModel):
    endpoint: str = Field(min_length=8, max_length=2048)
    message_ids: list[Annotated[str, Field(min_length=1, max_length=36)]] = Field(max_length=100)


@router.post("/ack")
async def acknowledge(body: PushAckIn, current_user: Annotated[User, Depends(get_current_user)],
                      db: Annotated[AsyncSession, Depends(get_db)]):
    """Конкретное устройство уже обработало сообщение; соединение само по себе не доказательство."""
    row = (await db.execute(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint,
        PushSubscription.user_id == current_user.id).with_for_update())).scalar_one_or_none()
    if row:
        ids = [mid for mid in body.message_ids if 0 < len(mid) <= 36]
        row.recent_message_ids = list(dict.fromkeys([*(row.recent_message_ids or []), *ids]))[-512:]
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


# --- Приложение для Android (Firebase Cloud Messaging) -------------------------------------------


class FcmDeviceIn(BaseModel):
    token: str = Field(min_length=20, max_length=4096)
    app_version: str | None = Field(default=None, max_length=32)


class FcmStatusOut(BaseModel):
    configured: bool


@router.get("/fcm", response_model=FcmStatusOut)
async def fcm_status():
    """Шлёт ли сервер уведомления в приложение для Android."""
    return FcmStatusOut(configured=fcm.configured())


@router.put("/fcm")
async def register_fcm_device(
    body: FcmDeviceIn,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Приложение сообщает адрес телефона. Вошли в другой аккаунт на том же телефоне — адрес переходит к нему."""
    row = (await db.execute(select(FcmDevice).where(FcmDevice.token == body.token))).scalar_one_or_none()
    if row:
        row.user_id = current_user.id
        row.app_version = body.app_version
    else:
        db.add(FcmDevice(user_id=current_user.id, token=body.token, app_version=body.app_version))
    await db.commit()
    return {"ok": True}


class FcmUnregisterIn(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


@router.post("/fcm/unregister")
async def unregister_fcm_device(body: FcmUnregisterIn, db: Annotated[AsyncSession, Depends(get_db)]):
    """Выход из аккаунта: уведомления на этот телефон больше не идут. Без входа — после выхода его уже нет;
    адрес знает только само приложение на этом телефоне."""
    row = (await db.execute(select(FcmDevice).where(FcmDevice.token == body.token))).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}

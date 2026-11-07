import hmac
import secrets
from datetime import timedelta
from typing import Annotated, Literal
from uuid import UUID
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core import connection_check as checks
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.push import push_configured
from app.models.connection_check import ConnectionCheck
from app.models.push import PushSubscription
from app.models.user import User

async def no_cache(response: Response): response.headers["Cache-Control"] = "no-store"
router = APIRouter(prefix="/push/diagnostics", tags=["connection-check"], dependencies=[Depends(no_cache)])
Db = Annotated[AsyncSession, Depends(get_db)]
Me = Annotated[User, Depends(get_current_user)]
class Start(BaseModel):
    id: UUID
    transport: Literal["push", "desktop"]
    endpoint: str | None = Field(default=None, min_length=8, max_length=2048)
    @model_validator(mode="after")
    def target(self):
        if (self.transport == "push") != bool(self.endpoint): raise ValueError("Specify the current push endpoint only for Web Push")
        return self
class Receipt(BaseModel):
    secret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")

def view(check):
    state = "expired" if check.expires_at <= checks.now() and check.state in ("queued", "sent") else check.state
    return {"id": check.id, "state": state, "error_code": check.error_code, "expires_at": check.expires_at}

@router.post("")
async def start(body: Start, request: Request, tasks: BackgroundTasks, me: Me, db: Db):
    # A per-user lock makes the persistent rate limit work across server workers.
    await db.execute(select(User.id).where(User.id == me.id).with_for_update())
    count = (await db.execute(select(func.count()).select_from(ConnectionCheck).where(ConnectionCheck.user_id == me.id,
        ConnectionCheck.created_at > checks.now() - timedelta(minutes=1)))).scalar_one()
    if count >= 3: raise HTTPException(status_code=429, detail="Можно провести три проверки в минуту. Подождите немного")
    if await db.get(ConnectionCheck, str(body.id)): raise HTTPException(status_code=409, detail="Создайте новую проверку")
    subscription = None
    if body.transport == "push":
        if not push_configured(): raise HTTPException(status_code=503, detail="Web Push пока не настроен на сервере")
        subscription = (await db.execute(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint, PushSubscription.user_id == me.id))).scalar_one_or_none()
        if not subscription or not subscription.enabled: raise HTTPException(status_code=404, detail="Подписка этого устройства не найдена или выключена. Переподключите уведомления")
        if not checks.allowed_endpoint(subscription.endpoint): raise HTTPException(status_code=422, detail="Сервис уведомлений этого браузера пока не поддерживается проверкой")
    secret = secrets.token_urlsafe(32)
    check = ConnectionCheck(id=str(body.id), user_id=me.id, session_id=request.state.device_session_id,
        subscription_id=subscription.id if subscription else None, transport=body.transport,
        state="queued", secret_hash=checks.digest(secret), created_at=checks.now(), expires_at=checks.now() + timedelta(minutes=2))
    db.add(check)
    await db.execute(delete(ConnectionCheck).where(ConnectionCheck.expires_at < checks.now() - timedelta(days=1)))
    await db.commit()
    tasks.add_task(checks.deliver, check.id, secret)
    return view(check)

@router.get("/{check_id}")
async def status(check_id: UUID, me: Me, db: Db):
    check = await db.get(ConnectionCheck, str(check_id))
    if not check or check.user_id != me.id: raise HTTPException(status_code=404, detail="Проверка не найдена")
    return view(check)

@router.post("/{check_id}/receipt", status_code=204)
async def receipt(check_id: UUID, body: Receipt, db: Db):
    check = (await db.execute(select(ConnectionCheck).where(ConnectionCheck.id == str(check_id)).with_for_update())).scalar_one_or_none()
    if not check or not hmac.compare_digest(check.secret_hash, checks.digest(body.secret)): raise HTTPException(status_code=404, detail="Проверка не найдена")
    if check.expires_at <= checks.now(): raise HTTPException(status_code=410, detail="Проверка завершена")
    check.state, check.error_code = "displayed", None
    await db.commit()

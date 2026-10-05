from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.user import User
from app.ws import calls as call_signaling

router = APIRouter(prefix="/calls", tags=["calls"])


class IceServerOut(BaseModel):
    urls: list[str] | str
    username: str | None = None
    credential: str | None = None


class IceConfigOut(BaseModel):
    iceServers: list[IceServerOut]


class CallOut(BaseModel):
    id: str
    chat_id: str
    caller_id: str | None
    callee_id: str | None
    media: str
    status: str
    started_at: datetime
    answered_at: datetime | None
    ended_at: datetime | None
    duration_sec: int | None

    model_config = {"from_attributes": True}


@router.get("/ice-servers", response_model=IceConfigOut)
async def get_ice_servers(current_user: Annotated[User, Depends(get_current_user)]):
    """ICE config for WebRTC. STUN always; TURN when configured (needed behind CGNAT)."""
    _ = current_user
    servers: list[IceServerOut] = [
        IceServerOut(urls=settings.webrtc_stun_urls_list),
    ]
    turn_urls = settings.webrtc_turn_urls_list
    if turn_urls and settings.WEBRTC_TURN_USERNAME and settings.WEBRTC_TURN_CREDENTIAL:
        servers.append(
            IceServerOut(
                urls=turn_urls,
                username=settings.WEBRTC_TURN_USERNAME,
                credential=settings.WEBRTC_TURN_CREDENTIAL,
            )
        )
    return IceConfigOut(iceServers=servers)


@router.get("/history", response_model=list[CallOut])
async def call_history(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(50, le=100),
):
    rows = await call_signaling.list_history_for_user(db, current_user.id, limit=limit)
    return rows

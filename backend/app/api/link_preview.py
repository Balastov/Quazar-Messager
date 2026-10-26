"""POST /link-preview — превью ссылки для отправителя (не чаще RATE в минуту на человека)."""

import time
from collections import defaultdict, deque
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import link_preview
from app.core.deps import get_current_user
from app.models.user import User

router = APIRouter(tags=["link-preview"])

RATE = 30
_recent: dict[str, deque[float]] = defaultdict(deque)


class PreviewIn(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


class PreviewOut(BaseModel):
    url: str
    title: str
    description: str
    site: str
    # data:image/…;base64 — клиент уменьшит и положит в сообщение.
    image: str | None


@router.post("/link-preview", response_model=PreviewOut | None)
async def make_preview(body: PreviewIn, current_user: Annotated[User, Depends(get_current_user)]):
    now = time.monotonic()
    recent = _recent[current_user.id]
    while recent and now - recent[0] > 60:
        recent.popleft()
    if len(recent) >= RATE:
        raise HTTPException(status_code=429, detail="Слишком много ссылок подряд — подождите минуту")
    recent.append(now)
    try:
        return await link_preview.fetch_preview(body.url)
    except link_preview.Blocked as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None

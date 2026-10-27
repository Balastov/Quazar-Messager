from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

TicketKind = Literal["idea", "question", "bug"]
TicketStatus = Literal["queued", "in_progress", "done"]

MAX_IMAGES = 5
TEXT_MAX = 4000


class TicketImage(BaseModel):
    """Картинка как в «IMG1:{…}»: вложение чата поддержки и ключ к нему."""

    id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    key: str = Field(min_length=1, max_length=64)
    mime: Literal["image/jpeg", "image/png", "image/gif", "image/webp"]
    w: int = Field(gt=0, le=20000)
    h: int = Field(gt=0, le=20000)
    size: int = Field(ge=0)


class CreateTicket(BaseModel):
    kind: TicketKind
    text: str = Field(max_length=TEXT_MAX)
    images: list[TicketImage] = Field(default_factory=list, max_length=MAX_IMAGES)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Опишите, что случилось или что предлагаете")
        return v

    @field_validator("images")
    @classmethod
    def _unique(cls, v: list[TicketImage]) -> list[TicketImage]:
        if len({ref.id for ref in v}) != len(v):
            raise ValueError("Картинка прикреплена дважды")
        return v


class TicketOut(BaseModel):
    id: str
    number: int
    kind: TicketKind
    text: str
    images: list[dict]
    status: TicketStatus
    chat_id: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TicketReply(BaseModel):
    text: str = Field(max_length=TEXT_MAX)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Пустой ответ")
        return v


class TicketStatusBody(BaseModel):
    status: TicketStatus

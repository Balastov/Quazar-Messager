from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.user import UserOut


class CreateDirectChat(BaseModel):
    user_id: str  # id собеседника


class CreateGroupChat(BaseModel):
    name: str
    member_ids: list[str]


class SetChatBackground(BaseModel):
    # «IMG1:{…}» (в личных чатах — зашифрованный ENC2) и вложение с самой картинкой.
    payload: str = Field(min_length=1, max_length=8000)
    attachment_id: str


class ChatMemberOut(BaseModel):
    user: UserOut
    role: str
    joined_at: datetime

    model_config = {"from_attributes": True}


# Исчезающие сообщения: 1 час, 1 день, 1 неделя.
TTL_CHOICES = (3600, 86400, 604800)


class SetChatTtl(BaseModel):
    ttl_seconds: int | None

    @field_validator("ttl_seconds")
    @classmethod
    def _ttl(cls, v: int | None) -> int | None:
        if v is not None and v not in TTL_CHOICES:
            raise ValueError("Можно 1 час, 1 день или 1 неделю")
        return v


class ChatOut(BaseModel):
    id: str
    # saved — «Избранное», чат с самим собой.
    type: Literal["direct", "group", "saved"]
    name: str | None
    created_at: datetime
    # Последнее сообщение / звонок / создание — для сортировки списка.
    last_activity_at: datetime | None = None
    # Общий фон (см. SetChatBackground); None — у каждого свой фон приложения.
    background: str | None = None
    # Исчезающие сообщения: сколько секунд живёт новое (None — не исчезают).
    ttl_seconds: int | None = None
    members: list[ChatMemberOut]

    model_config = {"from_attributes": True}

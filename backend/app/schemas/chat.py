from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

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


class ChatOut(BaseModel):
    id: str
    type: Literal["direct", "group"]
    name: str | None
    created_at: datetime
    # Последнее сообщение / звонок / создание — для сортировки списка.
    last_activity_at: datetime | None = None
    # Общий фон (см. SetChatBackground); None — у каждого свой фон приложения.
    background: str | None = None
    members: list[ChatMemberOut]

    model_config = {"from_attributes": True}

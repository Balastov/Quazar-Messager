from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.user import UserOut


class CreateDirectChat(BaseModel):
    user_id: str  # id собеседника


class CreateGroupChat(BaseModel):
    name: str
    member_ids: list[str]


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
    members: list[ChatMemberOut]

    model_config = {"from_attributes": True}

from datetime import datetime

from pydantic import BaseModel


class SendMessage(BaseModel):
    payload: str  # в фазе 4 будет зашифрован на клиенте


class MessageOut(BaseModel):
    id: str
    chat_id: str
    sender_id: str | None
    payload: str
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}

from datetime import datetime

from pydantic import BaseModel, Field

# Зашифрованный ENC2 текст в ~2.8 раза длиннее исходного; картинка «IMG1:{…}» — короткая.
MAX_PAYLOAD_LENGTH = 64_000
# Реакция в личном чате — зашифрованный эмодзи (ENC2 ≈ 200 символов).
MAX_REACTION_PAYLOAD_LENGTH = 1024


class SendMessage(BaseModel):
    payload: str = Field(min_length=1, max_length=MAX_PAYLOAD_LENGTH)  # в личных чатах — ENC2
    # Картинка, загруженная заранее в /chats/{chat_id}/attachments; ключ к ней — в payload.
    attachment_id: str | None = None
    # Ответ на сообщение этого же чата.
    reply_to_id: str | None = None


class EditMessage(BaseModel):
    payload: str = Field(min_length=1, max_length=MAX_PAYLOAD_LENGTH)


class SetReaction(BaseModel):
    payload: str = Field(min_length=1, max_length=MAX_REACTION_PAYLOAD_LENGTH)


class ReplyOut(BaseModel):
    """Цитата в ответе: исходное сообщение как есть (в личных чатах — зашифрованное)."""

    id: str
    sender_id: str | None
    payload: str


class ReactionOut(BaseModel):
    user_id: str
    payload: str


class MessageOut(BaseModel):
    id: str
    chat_id: str
    sender_id: str | None
    payload: str
    status: str
    created_at: datetime
    edited_at: datetime | None = None
    # Исчезающее сообщение: когда пропадёт у всех.
    expires_at: datetime | None = None
    reply_to: ReplyOut | None = None
    reactions: list[ReactionOut] = []

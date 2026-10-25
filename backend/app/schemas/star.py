from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.reactions import REACTIONS
from app.core.stars import MAX_MESSAGE_LENGTH, PLANET_MAX_CAPACITY, ROOM_KINDS

StarKind = Literal["gaming", "work"]
ChannelKind = Literal["satellite", "planet"]
Role = Literal["owner", "admin", "moderator", "member"]
AssignableRole = Literal["admin", "moderator", "member"]
RoomKind = Literal["coworking", "meeting", "smoking", "kitchen", "custom"]
Access = Literal["open", "invite", "personal"]

assert set(ROOM_KINDS) == {"coworking", "meeting", "smoking", "kitchen", "custom"}


class _Named(BaseModel):
    """Схлопывает пробелы в названии и не пропускает пустое."""

    @field_validator("name", check_fields=False)
    @classmethod
    def _clean_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = " ".join(v.split())
        if not v:
            raise ValueError("Название не может быть пустым")
        return v


class CreateStar(_Named):
    name: str = Field(min_length=1, max_length=64)
    kind: StarKind


class UpdateStar(_Named):
    name: str = Field(min_length=1, max_length=64)


class TransferStar(BaseModel):
    user_id: str


class UpdateMemberRole(BaseModel):
    role: AssignableRole


class UpdateRolePermissions(BaseModel):
    moderator: list[str]
    member: list[str]


class CreateInvite(BaseModel):
    expires_in_hours: int | None = Field(default=None, ge=1, le=24 * 30)
    max_uses: int | None = Field(default=None, ge=1, le=100)


class CreateChannel(_Named):
    kind: ChannelKind
    name: str = Field(min_length=1, max_length=48)
    capacity: int | None = Field(default=None, ge=1, le=PLANET_MAX_CAPACITY)
    room_kind: RoomKind | None = None
    access: Access = "open"
    # Чей личный кабинет (access == "personal").
    cabinet_owner_id: str | None = None
    # «Только слушать»: без микрофонов.
    listen_only: bool = False
    # Этаж для комнаты в Звезде «Работа»; по умолчанию — первый.
    floor_id: str | None = None


class UpdateChannel(_Named):
    name: str | None = Field(default=None, min_length=1, max_length=48)
    capacity: int | None = Field(default=None, ge=1, le=PLANET_MAX_CAPACITY)
    room_kind: RoomKind | None = None
    access: Access | None = None
    cabinet_owner_id: str | None = None
    listen_only: bool | None = None
    # Перенести комнату на другой этаж (нужно право «Редактировать карту офиса»).
    floor_id: str | None = None


class CreateFloor(_Named):
    name: str = Field(min_length=1, max_length=48)


class UpdateFloor(_Named):
    name: str = Field(min_length=1, max_length=48)


class LayoutRoom(BaseModel):
    channel_id: str
    x: int
    y: int
    w: int
    h: int


class SaveLayout(BaseModel):
    # Версия плана, с которой человек начинал править.
    version: int
    rooms: list[LayoutRoom]


class ReorderChannels(BaseModel):
    channel_ids: list[str]


class _StarText(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_LENGTH)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Сообщение не может быть пустым")
        return v


class SendStarMessage(_StarText):
    # Ответ на сообщение этого же Спутника.
    reply_to_id: str | None = None


class EditStarMessage(_StarText):
    pass


class SetStarReaction(BaseModel):
    emoji: str

    @field_validator("emoji")
    @classmethod
    def _emoji(cls, v: str) -> str:
        if v not in REACTIONS:
            raise ValueError("Такой реакции нет")
        return v


class StarUserOut(BaseModel):
    id: str
    username: str
    avatar_url: str | None


class StarMemberOut(BaseModel):
    user: StarUserOut
    role: Role
    joined_at: datetime


class StarChannelOut(BaseModel):
    id: str
    star_id: str
    kind: ChannelKind
    name: str
    position: int
    capacity: int | None
    room_kind: str | None
    access: str = "open"
    cabinet_owner_id: str | None = None
    listen_only: bool = False
    floor_id: str | None = None
    map_x: int | None
    map_y: int | None
    map_w: int | None
    map_h: int | None

    model_config = {"from_attributes": True}


class StarFloorOut(BaseModel):
    id: str
    name: str
    position: int
    version: int

    model_config = {"from_attributes": True}


class LayoutOut(BaseModel):
    floor: StarFloorOut
    rooms: list[LayoutRoom]


class StarSummaryOut(BaseModel):
    id: str
    name: str
    kind: StarKind
    owner_id: str
    avatar_url: str | None
    background_url: str | None
    created_at: datetime
    member_count: int
    my_role: Role


class VoiceParticipantOut(BaseModel):
    user_id: str
    joined_at: datetime
    server_muted: bool
    screen_sharing: bool = False
    # Главный в комнате «По приглашениям»: первый вошедший, пока не выйдет или не передаст.
    is_host: bool = False


class StarDetailOut(StarSummaryOut):
    my_permissions: list[str]
    role_permissions: dict[str, list[str]]
    channels: list[StarChannelOut]
    members: list[StarMemberOut]
    # Кто сейчас на какой Планете: channel_id -> участники.
    voice: dict[str, list[VoiceParticipantOut]] = {}
    # Этажи карты офиса (только у Звёзд «Работа»).
    floors: list[StarFloorOut] = []


class StarReplyOut(BaseModel):
    """Цитата в ответе."""

    id: str
    sender: StarUserOut | None
    text: str


class StarReactionOut(BaseModel):
    user_id: str
    emoji: str


class StarMessageOut(BaseModel):
    id: str
    star_id: str
    channel_id: str
    sender: StarUserOut | None
    text: str
    created_at: datetime
    edited_at: datetime | None = None
    reply_to: StarReplyOut | None = None
    reactions: list[StarReactionOut] = []


class StarInviteOut(BaseModel):
    code: str
    star_id: str
    created_by: str | None
    created_at: datetime
    expires_at: datetime | None
    max_uses: int | None
    uses: int

    model_config = {"from_attributes": True}


class InvitePreviewOut(BaseModel):
    code: str
    star_id: str
    star_name: str
    star_kind: StarKind
    star_avatar_url: str | None
    member_count: int
    already_member: bool


class StarBanOut(BaseModel):
    user: StarUserOut
    banned_by: str | None
    created_at: datetime


class StarLimitsOut(BaseModel):
    max_owned_stars: int
    owned_stars: int
    max_star_members: int
    gaming_max_satellites: int
    gaming_max_planets: int
    planet_max_capacity: int
    room_kinds: dict[str, int]

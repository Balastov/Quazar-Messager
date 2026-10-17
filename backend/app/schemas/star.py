from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.stars import MAX_MESSAGE_LENGTH, PLANET_MAX_CAPACITY, ROOM_KINDS

StarKind = Literal["gaming", "work"]
ChannelKind = Literal["satellite", "planet"]
Role = Literal["owner", "admin", "moderator", "member"]
AssignableRole = Literal["admin", "moderator", "member"]
RoomKind = Literal["coworking", "meeting", "smoking", "kitchen", "custom"]

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


class UpdateChannel(_Named):
    name: str | None = Field(default=None, min_length=1, max_length=48)
    capacity: int | None = Field(default=None, ge=1, le=PLANET_MAX_CAPACITY)
    room_kind: RoomKind | None = None


class ReorderChannels(BaseModel):
    channel_ids: list[str]


class SendStarMessage(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_LENGTH)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Сообщение не может быть пустым")
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
    map_x: int | None
    map_y: int | None
    map_w: int | None
    map_h: int | None

    model_config = {"from_attributes": True}


class StarSummaryOut(BaseModel):
    id: str
    name: str
    kind: StarKind
    owner_id: str
    created_at: datetime
    member_count: int
    my_role: Role


class VoiceParticipantOut(BaseModel):
    user_id: str
    joined_at: datetime
    server_muted: bool


class StarDetailOut(StarSummaryOut):
    my_permissions: list[str]
    role_permissions: dict[str, list[str]]
    channels: list[StarChannelOut]
    members: list[StarMemberOut]
    # Кто сейчас на какой Планете: channel_id -> участники.
    voice: dict[str, list[VoiceParticipantOut]] = {}


class StarMessageOut(BaseModel):
    id: str
    star_id: str
    channel_id: str
    sender: StarUserOut | None
    text: str
    created_at: datetime


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

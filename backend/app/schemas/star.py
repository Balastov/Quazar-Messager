from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.reactions import REACTIONS
from app.core.stars import MAX_MESSAGE_LENGTH, PLANET_MAX_CAPACITY, ROOM_KINDS, SLOW_MODE_SECONDS

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
    # Спутник-объявления: пишут только владелец и админы.
    announcement: bool = False
    # Этаж для комнаты в Звезде «Работа»; по умолчанию — первый.
    floor_id: str | None = None


class UpdateChannel(_Named):
    name: str | None = Field(default=None, min_length=1, max_length=48)
    capacity: int | None = Field(default=None, ge=1, le=PLANET_MAX_CAPACITY)
    room_kind: RoomKind | None = None
    access: Access | None = None
    cabinet_owner_id: str | None = None
    listen_only: bool | None = None
    # Медленный режим Спутника: 0, 10, 30, 60 или 300 секунд.
    slow_mode_sec: int | None = None
    announcement: bool | None = None
    # Перенести комнату на другой этаж (нужно право «Редактировать карту офиса»).
    floor_id: str | None = None

    @field_validator("slow_mode_sec")
    @classmethod
    def _slow(cls, v: int | None) -> int | None:
        if v is not None and v not in SLOW_MODE_SECONDS:
            raise ValueError("Медленный режим: 0, 10, 30, 60 или 300 секунд")
        return v


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


class LinkPreview(BaseModel):
    """Превью ссылки — собирает отправитель (POST /link-preview), картинку уменьшает сам."""

    url: str = Field(max_length=2048, pattern=r"^https?://")
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=300)
    site: str = Field(default="", max_length=100)
    image: str | None = Field(default=None, max_length=120_000, pattern=r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")


class SendStarMessage(BaseModel):
    # С файлом текст — необязательная подпись.
    text: str = Field(default="", max_length=MAX_MESSAGE_LENGTH)
    # Файл, загруженный в этот Спутник (POST …/files).
    file_id: str | None = None
    # Ответ на сообщение этого же Спутника.
    reply_to_id: str | None = None
    # Ответ в ветке этого сообщения (корня).
    thread_id: str | None = None
    # Объявление с «Ознакомлен(а)» (только в Спутнике-объявлениях, только владелец и админы).
    ack_required: bool = False
    link_preview: LinkPreview | None = None

    @model_validator(mode="after")
    def _text_or_file(self):
        if not self.text.strip():
            if not self.file_id:
                raise ValueError("Сообщение не может быть пустым")
            self.text = ""
        return self


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
    # «Имя Фамилия» или никнейм, если имя не указано.
    display_name: str = ""
    avatar_url: str | None


class StarMemberOut(BaseModel):
    user: StarUserOut
    role: Role
    joined_at: datetime
    # Свои роли-подписи (StarTag.id).
    tag_ids: list[str] = []
    # В тайм-ауте до этого момента (None — нет).
    timeout_until: datetime | None = None
    # Свой рабочий график (только если в Звезде включено рабочее время).
    work_schedule: dict | None = None


class StarTagOut(BaseModel):
    id: str
    name: str
    color: str
    self_assign: bool
    # Имя для упоминания группы (без «@»); None — роль не упоминается.
    handle: str | None = None
    position: int

    model_config = {"from_attributes": True}


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
    slow_mode_sec: int = 0
    temporary: bool = False
    created_by: str | None = None
    announcement: bool = False
    # Табличка на двери кабинета: dnd | welcome | away | custom. Истёкшая — не показывается.
    door_sign_kind: str | None = None
    door_sign_text: str | None = None
    door_sign_until: datetime | None = None
    floor_id: str | None = None
    map_x: int | None
    map_y: int | None
    map_w: int | None
    map_h: int | None

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def _expired_sign(self):
        if self.door_sign_until and self.door_sign_until <= datetime.now(timezone.utc):
            self.door_sign_kind = self.door_sign_text = self.door_sign_until = None
        return self


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
    # Гость по ссылке: его имя (у участников Звезды — None).
    guest_name: str | None = None


class StarDetailOut(StarSummaryOut):
    my_permissions: list[str]
    role_permissions: dict[str, list[str]]
    channels: list[StarChannelOut]
    members: list[StarMemberOut]
    # Кто сейчас на какой Планете: channel_id -> участники.
    voice: dict[str, list[VoiceParticipantOut]] = {}
    # С какого момента на Планете кто-то есть без перерыва: channel_id -> время.
    voice_since: dict[str, datetime] = {}
    rules_text: str | None = None
    # Я уже согласился с правилами (или правил нет, или я модератор и выше).
    rules_accepted: bool = True
    welcome_text: str | None = None
    welcome_channel_id: str | None = None
    soundboard: bool = True
    # Только владельцу и админам — остальным пустой список.
    banned_words: list[str] = []
    tags: list[StarTagOut] = []
    # Рабочее время: включено ли и общий график Звезды.
    work_hours_enabled: bool = False
    work_hours: dict | None = None
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


class PollOptionOut(BaseModel):
    text: str
    votes: int
    # Кто голосовал — только в неанонимных опросах.
    voters: list[str] = []


class PollOut(BaseModel):
    id: str
    question: str
    options: list[PollOptionOut]
    multiple: bool
    anonymous: bool
    closes_at: datetime | None
    closed: bool
    total_voters: int
    # Мои варианты — у каждого свои (в рассылке всем — пусто, клиент хранит свой выбор).
    my_votes: list[int] = []
    created_by: str | None


class LfgOut(BaseModel):
    id: str
    title: str
    slots: int
    starts_at: datetime | None
    status: Literal["open", "started", "cancelled"]
    members: list[str]
    planet_id: str | None
    created_by: str | None


class StarFileOut(BaseModel):
    id: str
    name: str
    mime: str
    size: int


class StarFileListItem(StarFileOut):
    """Файл в разделе «Файлы» Звезды."""

    channel_id: str
    message_id: str | None
    uploader: StarUserOut | None
    created_at: datetime


class StarMessageOut(BaseModel):
    id: str
    star_id: str
    channel_id: str
    sender: StarUserOut | None
    text: str
    # text | system | poll | lfg | file
    kind: str = "text"
    file: StarFileOut | None = None
    # Упомянутые участники (@имя) и @все.
    mentions: list[str] = []
    mention_all: bool = False
    link_preview: LinkPreview | None = None
    # Сообщение интеграции (kind == "bot"): имя вебхука и сервис (github, grafana…).
    bot_name: str | None = None
    bot_kind: str | None = None
    poll: PollOut | None = None
    lfg: LfgOut | None = None
    # Ответ в ветке — id корня; у корня — сводка ветки.
    thread_id: str | None = None
    thread_count: int = 0
    thread_last_at: datetime | None = None
    thread_participants: list[str] = []
    # Объявление с подтверждением.
    ack_required: bool = False
    ack_count: int = 0
    acked: bool = False
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

"""Созвездие: Звёзды (серверы), их участники, каналы (Спутники и Планеты) и сообщения.

Сквозного шифрования здесь нет — как в Дискорде, сервер видит сообщения Спутников.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Star(Base):
    __tablename__ = "stars"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    # /media/avatars/stars/<id>.<ext>?v=… — ставят владелец и админы.
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Фон Звезды для всех участников (/media/backgrounds/…) — ставят владелец и админы.
    background_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # "gaming" | "work" — задаётся при создании и не меняется.
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    owner_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Настраиваемые права ролей: {"moderator": [...], "member": [...]}.
    role_permissions: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # Правила: пока участник (ниже модератора) их не принял, писать в Спутники не может.
    rules_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Приветствие новичка в Спутнике welcome_channel_id; {name} — имя новичка.
    welcome_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    welcome_channel_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # Запрещённые слова: сообщения с ними не отправляются (кроме владельца и админов).
    banned_words: Mapped[list] = mapped_column(JSON, nullable=False, default=list, server_default="[]")
    # Звуковая панель на Планетах.
    soundboard: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    # Рабочее время: включают владелец и админы; work_hours — общий график по умолчанию
    # {"days": [1..7, пн=1], "start": "09:00", "end": "18:00", "tz": "Europe/Moscow"}.
    work_hours_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    work_hours: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarMember(Base):
    __tablename__ = "star_members"

    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    # "owner" | "admin" | "moderator" | "member"
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="member")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    # Тайм-аут: до этого момента не пишет, не ставит реакции и молчит на Планетах.
    timeout_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rules_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StarFloor(Base):
    """Этаж карты офиса (только для Звёзд «Работа»)."""

    __tablename__ = "star_floors"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(48), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Растёт при каждом сохранении плана — ловим одновременные правки двух людей.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarChannel(Base):
    __tablename__ = "star_channels"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # "satellite" (текстовый) | "planet" (голосовой)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    name: Mapped[str] = mapped_column(String(48), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Только для Планет.
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Тип комнаты: coworking | meeting | smoking | kitchen | custom | lobby (зал ожидания, системный)
    room_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Доступ к Планете: "open" (свободный вход) | "invite" (по приглашениям — стучаться) |
    # "personal" (личный кабинет, только в Звёздах «Работа»).
    access: Mapped[str] = mapped_column(String(16), nullable=False, default="open", server_default="open")
    # Хозяин личного кабинета: входит без стука, зовёт и впускает (вместе с админами и владельцем).
    cabinet_owner_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # «Только слушать»: микрофоны на Планете не открываются вообще (сервер их и не пропустит).
    # Показ экрана остаётся.
    listen_only: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Медленный режим Спутника: не чаще одного сообщения в столько секунд (модераторам — без ограничений).
    slow_mode_sec: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # Канал объявлений: пишут только владелец и админы, можно просить «Ознакомлен(а)».
    announcement: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Табличка на двери кабинета: dnd | welcome | away | custom, текст и до какого времени.
    door_sign_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    door_sign_text: Mapped[str | None] = mapped_column(String(80), nullable=True)
    door_sign_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Временная Планета: создал любой участник, удаляется сама, когда опустеет.
    temporary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    created_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Этаж и положение на карте офиса в клетках сетки.
    floor_id: Mapped[str | None] = mapped_column(
        ForeignKey("star_floors.id", ondelete="SET NULL"), nullable=True, index=True
    )
    map_x: Mapped[int | None] = mapped_column(Integer, nullable=True)
    map_y: Mapped[int | None] = mapped_column(Integer, nullable=True)
    map_w: Mapped[int | None] = mapped_column(Integer, nullable=True)
    map_h: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarMessage(Base):
    __tablename__ = "star_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    channel_id: Mapped[str] = mapped_column(
        ForeignKey("star_channels.id", ondelete="CASCADE"), nullable=False, index=True
    )
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # text | system (приветствие) | poll | lfg — у poll и lfg ref_id указывает на опрос или сбор.
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="text", server_default="text")
    ref_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # Ответ в ветке: корневое сообщение. В ленте Спутника такие не показываются.
    thread_id: Mapped[str | None] = mapped_column(
        ForeignKey("star_messages.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # Объявление, по которому просят подтвердить «Ознакомлен(а)».
    ack_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Ответ на сообщение того же Спутника; удалили исходное — ответ остаётся без цитаты.
    reply_to_id: Mapped[str | None] = mapped_column(
        ForeignKey("star_messages.id", ondelete="SET NULL"), nullable=True
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, index=True
    )


class StarMessageReaction(Base):
    """Реакция на сообщение Спутника — одна на человека."""

    __tablename__ = "star_message_reactions"

    message_id: Mapped[str] = mapped_column(
        ForeignKey("star_messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    emoji: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarInvite(Base):
    __tablename__ = "star_invites"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    uses: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class StarBan(Base):
    __tablename__ = "star_bans"
    __table_args__ = (UniqueConstraint("star_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    banned_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarTag(Base):
    """Своя роль с цветом. Права не даёт — это подпись: цвет имени, отметка в списке участников.
    self_assign — участник может выбрать её себе сам («Танк», «Хил», «Новичок»)."""

    __tablename__ = "star_tags"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(32), nullable=False)
    color: Mapped[str] = mapped_column(String(7), nullable=False)
    self_assign: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarMemberTag(Base):
    __tablename__ = "star_member_tags"

    tag_id: Mapped[str] = mapped_column(
        ForeignKey("star_tags.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )


class StarAudit(Base):
    """Журнал действий: кто кого выгнал, заглушил, кому поменял роль, что настроил."""

    __tablename__ = "star_audit"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    actor_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class StarPoll(Base):
    __tablename__ = "star_polls"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question: Mapped[str] = mapped_column(String(300), nullable=False)
    options: Mapped[list] = mapped_column(JSON, nullable=False)
    multiple: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    anonymous: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    closes_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarPollVote(Base):
    __tablename__ = "star_poll_votes"

    poll_id: Mapped[str] = mapped_column(
        ForeignKey("star_polls.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    option: Mapped[int] = mapped_column(Integer, primary_key=True)


class StarLfg(Base):
    """Сбор группы: «Ищу пати: Dota, 5 мест, 21:00». В начале — временная Планета для всех записавшихся."""

    __tablename__ = "star_lfg"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    channel_id: Mapped[str] = mapped_column(
        ForeignKey("star_channels.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    slots: Mapped[int] = mapped_column(Integer, nullable=False)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    # open | started | cancelled
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    planet_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarLfgMember(Base):
    __tablename__ = "star_lfg_members"

    lfg_id: Mapped[str] = mapped_column(
        ForeignKey("star_lfg.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarAsset(Base):
    """Стикер, эмодзи или звук Звезды. Файл — /media/stars/<star_id>/<id>.<ext>, публичный по ссылке."""

    __tablename__ = "star_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # sticker | emoji | sound
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Для эмодзи — код в тексте: :name:. Для звука — подпись на кнопке.
    name: Mapped[str] = mapped_column(String(32), nullable=False)
    # Значок на кнопке звука.
    emoji: Mapped[str | None] = mapped_column(String(16), nullable=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    mime: Mapped[str] = mapped_column(String(32), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarMessageAck(Base):
    """«Ознакомлен(а)» под объявлением."""

    __tablename__ = "star_message_acks"

    message_id: Mapped[str] = mapped_column(
        ForeignKey("star_messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StarBooking(Base):
    """Бронь комнаты (Планеты рабочей Звезды) на время: напоминание и статус «на встрече»."""

    __tablename__ = "star_bookings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    star_id: Mapped[str] = mapped_column(
        ForeignKey("stars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    channel_id: Mapped[str] = mapped_column(
        ForeignKey("star_channels.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    attendees: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # Уже напомнили (за 10 минут) и уже поставили «на встрече» в начале.
    reminded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    started: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

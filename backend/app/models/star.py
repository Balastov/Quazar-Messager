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
    # "gaming" | "work" — задаётся при создании и не меняется.
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    owner_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Настраиваемые права ролей: {"moderator": [...], "member": [...]}.
    role_permissions: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, index=True
    )


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

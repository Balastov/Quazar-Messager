"""Контакты из телефонной книги: только найденные пользователи Quazar и имя из книги.

Номера, по которым никого не нашли, сервер не хранит.
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class UserContact(Base):
    __tablename__ = "user_contacts"

    owner_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    contact_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # Как человек записан в телефоне у владельца.
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ContactSync(Base):
    """Когда телефон последний раз присылал книгу (чтобы показать это в вебе)."""

    __tablename__ = "contact_syncs"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    # Сколько записей было в книге — для «нашли 3 из 240».
    total: Mapped[int] = mapped_column(Integer, default=0)

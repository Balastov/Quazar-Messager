"""Журнал входов, выходов и отказов в сессии — чтобы понять, почему человеку пришлось войти заново."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AuthEvent(Base):
    __tablename__ = "auth_events"
    # Без внешних ключей: запись пишется отдельной транзакцией, пока запрос может держать блокировки
    # на users и device_sessions, — так она их не ждёт. И переживает удаление аккаунта (до очистки).
    __table_args__ = (Index("ix_auth_events_user_at", "user_id", "at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # login / login_failed / rejected / logout / revoked
    event: Mapped[str] = mapped_column(String(16), nullable=False)
    # Способ входа, причина отказа или выхода (коды — в app/core/auth_log.py).
    reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    detail: Mapped[str | None] = mapped_column(String(300), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Что за приложение: заголовок X-Quazar-Client (web, desktop/2.8.0, android, ios); пусто — старая сборка.
    client: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Какой запрос получил отказ: «GET /users/me», «WS /ws».
    path: Mapped[str | None] = mapped_column(String(120), nullable=True)

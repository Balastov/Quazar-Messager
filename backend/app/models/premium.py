"""Quazar Premium: история выдач. Текущее состояние продублировано в users (premium_kind, premium_until)."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PremiumGrant(Base):
    __tablename__ = "premium_grants"
    __table_args__ = (
        # Пробный месяц — один раз на аккаунт и один раз на номер телефона.
        Index("ux_premium_trial_user", "user_id", unique=True, postgresql_where=text("kind = 'trial'")),
        Index("ux_premium_trial_phone", "phone_hash", unique=True, postgresql_where=text("kind = 'trial'")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Удалённый аккаунт — null: запись о пробном месяце с этим номером остаётся.
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    # trial — пробный; purchase — купленный; gift — выдан в «Чёрной дыре».
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # null — бессрочный.
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Хеш номера, с которым взяли пробный период: новый аккаунт на тот же номер второй раз его не получит.
    phone_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

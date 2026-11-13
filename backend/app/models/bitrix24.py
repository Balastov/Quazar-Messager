"""OAuth credentials stay server-side; handoff codes are single use and hashed."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BitrixInstallation(Base):
    __tablename__ = "bitrix_installations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    origin: Mapped[str] = mapped_column(String(255), unique=True)
    member_id: Mapped[str] = mapped_column(String(128), unique=True)
    application_token_hash: Mapped[str] = mapped_column(String(64))


class BitrixCredential(Base):
    __tablename__ = "bitrix_credentials"
    __table_args__ = (UniqueConstraint("installation_id", "employee_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    installation_id: Mapped[str] = mapped_column(ForeignKey("bitrix_installations.id", ondelete="CASCADE"))
    employee_id: Mapped[str] = mapped_column(String(32))
    tokens: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class BitrixHandoff(Base):
    __tablename__ = "bitrix_handoffs"
    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    credential_id: Mapped[str] = mapped_column(ForeignKey("bitrix_credentials.id", ondelete="CASCADE"))
    display_name: Mapped[str] = mapped_column(String(160))
    mode: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

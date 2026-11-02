"""Ручное восстановление доступа: публичная заявка → «Ошибка» → назначение пароля владельцем ресурса."""

import asyncio
import time
from collections import defaultdict, deque

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select

from app.api.admin import Super, Db
from app.api.support import AdminTicketDetail, _detail
from app.core import passwords, support
from app.core.phone import normalize_ru_phone
from app.core.security import create_access_token
from app.models.support import SupportTicket
from app.models.user import User

router = APIRouter(prefix="/auth", tags=["auth"])
admin_router = APIRouter(prefix="/admin/tickets", tags=["admin"], include_in_schema=False)
RECOVERY_MESSAGE = "Если аккаунт найден, запрос передан администратору. Для получения нового пароля свяжитесь с администратором привычным способом."
MIN_RESPONSE_SECONDS = 0.3
REQUESTS_PER_HOUR = 20
_requests: dict[str, deque[float]] = defaultdict(deque)


class ForgotPasswordBody(BaseModel):
    login: str = Field(min_length=1, max_length=128)

    @field_validator("login")
    @classmethod
    def nonblank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Введите логин")
        return value


class RecoveryOut(BaseModel):
    message: str = RECOVERY_MESSAGE


class AssignPasswordBody(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)
    confirm_password: str = Field(min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def valid_password(cls, value: str) -> str:
        return passwords.validate_password(value)

    @model_validator(mode="after")
    def same_passwords(self):
        if self.new_password != self.confirm_password:
            raise ValueError("Новые пароли не совпадают")
        return self


class AssignedPasswordOut(BaseModel):
    ticket: AdminTicketDetail
    # Только при смене собственного пароля администратора, не токен чужого аккаунта.
    access_token: str | None = None


def _limit(request: Request) -> None:
    stamp = time.monotonic()
    ip = request.client.host if request.client else "unknown"
    recent = _requests[ip]
    while recent and recent[0] < stamp - 3600:
        recent.popleft()
    if len(recent) >= REQUESTS_PER_HOUR:
        raise HTTPException(status_code=429, detail="Слишком много запросов. Попробуйте позже")
    recent.append(stamp)
    if len(_requests) > 5000:
        for key in [key for key, values in _requests.items() if not values or values[-1] < stamp - 3600]:
            _requests.pop(key, None)


@router.post("/forgot-password", response_model=RecoveryOut, status_code=202)
async def forgot_password(body: ForgotPasswordBody, request: Request, db: Db):
    _limit(request)
    started = time.monotonic()
    try:
        condition = func.lower(User.username) == body.login.removeprefix("@").lower()
        if body.login[0].isdigit() or body.login[0] in "+(":
            try:
                condition = User.phone == normalize_ru_phone(body.login)
            except ValueError:
                pass
        user = (await db.execute(select(User).where(condition, User.is_official.is_(False),
                                                   User.is_active.is_(True), User.blocked_at.is_(None), User.phone_verified_at.is_(None)))).scalar_one_or_none()
        if user:
            # Создание служебного чата может коммитить: оно идёт до блокировки заявки.
            await support.support_chat(db, user)
            await db.execute(select(User.id).where(User.id == user.id).with_for_update())
            pending = (await db.execute(select(SupportTicket.id).where(SupportTicket.user_id == user.id,
                SupportTicket.recovery_login.is_not(None), SupportTicket.password_reset_at.is_(None),
                SupportTicket.status != "done").limit(1))).scalar_one_or_none()
            if not pending:
                await support.create_ticket(db, user, "bug",
                    f"Забыл пароль.\nУказанный логин: {body.login}\nЗапрос создан на экране входа без авторизации.", [],
                    recovery_login=body.login)
        return RecoveryOut()
    finally:
        await asyncio.sleep(max(0, MIN_RESPONSE_SECONDS - (time.monotonic() - started)))


@admin_router.post("/{ticket_id}/password", response_model=AssignedPasswordOut)
async def assign_password(ticket_id: str, body: AssignPasswordBody, me: Super, db: Db):
    ticket = await db.get(SupportTicket, ticket_id)
    if not ticket or ticket.recovery_login is None:
        raise HTTPException(status_code=404, detail="Запрос восстановления не найден")
    user = (await db.execute(select(User).where(User.id == ticket.user_id).with_for_update()
                             .execution_options(populate_existing=True))).scalar_one_or_none()
    ticket = (await db.execute(select(SupportTicket).where(SupportTicket.id == ticket_id).with_for_update()
                               .execution_options(populate_existing=True))).scalar_one()
    if ticket.password_reset_at or ticket.status == "done":
        raise HTTPException(status_code=409, detail="Этот запрос восстановления уже завершён")
    if not user or user.is_official or not user.is_active or user.blocked_at:
        raise HTTPException(status_code=400, detail="Аккаунт недоступен для восстановления")
    if user.phone_verified_at:
        raise HTTPException(status_code=403, detail="Телефон подтверждён: парольное восстановление отключено")
    passwords.assign_password(user, body.new_password)
    tickets = await passwords.complete_recoveries(db, user, me)
    await db.commit()
    token = create_access_token(user.id) if user.id == me.id else None
    await passwords.close_sessions(user.id)
    for changed in tickets:
        await support.notify_team(db, changed)
    return AssignedPasswordOut(ticket=await _detail(db, ticket), access_token=token)

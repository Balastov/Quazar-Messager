from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.accounts import TAKEN, email_taken, phone_taken, username_taken
from app.core.phone_verification import consume as consume_phone_verification
from app.core.database import get_db
from app.core.profile import normalize_username
from app.core.security import create_access_token, verify_password
from app.models.user import User
from app.schemas.user import TokenResponse, UserLogin, UsernameCheckOut, UserRegister

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/username-available", response_model=UsernameCheckOut)
async def username_available(
    username: Annotated[str, Query(max_length=64)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Проверка никнейма при вводе (регистрация и смена в профиле)."""
    try:
        name = normalize_username(username)
    except ValueError as exc:
        return UsernameCheckOut(available=False, reason=str(exc))
    if await username_taken(db, name):
        return UsernameCheckOut(available=False, reason=TAKEN["username"])
    return UsernameCheckOut(available=True)


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(body: UserRegister, db: Annotated[AsyncSession, Depends(get_db)]):
    if await phone_taken(db, body.phone):
        raise HTTPException(status_code=400, detail=TAKEN["phone"])
    if await username_taken(db, body.username):
        raise HTTPException(status_code=400, detail=TAKEN["username"])
    if body.email and await email_taken(db, body.email):
        raise HTTPException(status_code=400, detail=TAKEN["email"])

    verified_at = await consume_phone_verification(db, body.phone, body.phone_verification_token)

    user = User(
        username=body.username,
        phone=body.phone,
        phone_verified_at=verified_at,
        sessions_revoked_at=verified_at,
        email=body.email,
        first_name=body.first_name,
        last_name=body.last_name,
        phone_discoverable=body.phone_discoverable,
        password_hash=None,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        # Одновременная регистрация с теми же данными — уникальные индексы не пустят второго.
        await db.rollback()
        raise HTTPException(
            status_code=400, detail="Номер, никнейм или почта уже заняты"
        ) from None
    await db.refresh(user)

    return TokenResponse(access_token=create_access_token(user.id))


@router.post("/login", response_model=TokenResponse)
async def login(body: UserLogin, db: Annotated[AsyncSession, Depends(get_db)]):
    result = await db.execute(select(User).where(User.phone == body.phone))
    user = result.scalar_one_or_none()

    if user and user.phone_verified_at:
        raise HTTPException(status_code=403, detail="Телефон подтверждён. Войдите звонком или через привязанный Яндекс ID")
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    # Пока проверяли хэш, администратор мог назначить другой пароль.
    # Короткая блокировка после проверки не даёт выпустить новую сессию по старому хэшу.
    verified_hash = user.password_hash
    user = (await db.execute(select(User).where(User.id == user.id).with_for_update()
                             .execution_options(populate_existing=True))).scalar_one_or_none()
    if not user or user.password_hash != verified_hash:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.phone_verified_at:
        raise HTTPException(status_code=403, detail="Телефон подтверждён. Войдите звонком или через привязанный Яндекс ID")
    if user.blocked_at:
        raise HTTPException(status_code=403, detail="Аккаунт заблокирован администрацией")

    return TokenResponse(access_token=create_access_token(user.id))

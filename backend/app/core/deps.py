from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_token
from app.models.user import User

bearer = HTTPBearer()
_optional_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    user_id = decode_token(credentials.credentials)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if user.blocked_at:
        # 401 — клиент выйдет из аккаунта.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Аккаунт заблокирован")

    return user


async def get_superuser(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_optional_bearer)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    """Владелец ресурса. Всем остальным, в том числе без входа, — тот же 404, что у несуществующего
    адреса: по ответам о разделе не узнать."""
    not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    user_id = decode_token(credentials.credentials) if credentials else None
    if not user_id:
        raise not_found
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user or user.blocked_at or not user.is_superuser:
        raise not_found
    return user

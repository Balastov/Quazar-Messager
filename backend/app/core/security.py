from datetime import datetime, timedelta, timezone
from typing import Optional
import math

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str | None) -> bool:
    """Аккаунт без пароля (создан через внешний вход) паролем не открывается."""
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        # Испорченный хэш в базе — не пускаем, а не падаем.
        return False


def create_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "iat": datetime.now(timezone.utc).timestamp(),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_ACCESS_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None


def token_is_current(token: str, user) -> bool:
    changed = max((value for value in (getattr(user, "password_changed_at", None),
        getattr(user, "sessions_revoked_at", None)) if value is not None), default=None)
    if changed is None:
        return True
    try:
        claims = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        issued = claims.get("iat")
        return (isinstance(issued, (int, float)) and not isinstance(issued, bool) and math.isfinite(issued)
                and issued >= changed.timestamp())
    except (JWTError, TypeError, ValueError, OverflowError):
        return False

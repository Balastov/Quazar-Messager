from datetime import datetime

from pydantic import BaseModel, field_validator

from app.core.phone import normalize_ru_phone
from app.core.profile import normalize_email, normalize_person_name, normalize_username


class UserRegister(BaseModel):
    # Обязательны телефон, никнейм и пароль; почту и имя клиент предлагает указать
    # сразу после регистрации, но их можно прислать и здесь.
    username: str
    phone: str
    password: str
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None

    @field_validator("username")
    @classmethod
    def username_valid(cls, v: str) -> str:
        return normalize_username(v)

    @field_validator("phone")
    @classmethod
    def phone_valid(cls, v: str) -> str:
        return normalize_ru_phone(v)

    @field_validator("password")
    @classmethod
    def password_valid(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Пароль — не короче 8 символов")
        return v

    @field_validator("email")
    @classmethod
    def email_valid(cls, v: str | None) -> str | None:
        return normalize_email(v)

    @field_validator("first_name", "last_name")
    @classmethod
    def name_valid(cls, v: str | None) -> str | None:
        return normalize_person_name(v)


class UserLogin(BaseModel):
    phone: str
    password: str

    @field_validator("phone")
    @classmethod
    def phone_valid(cls, v: str) -> str:
        return normalize_ru_phone(v)


class UpdateProfile(BaseModel):
    """Правка профиля: не присланное поле не меняется; пустая строка почты или имени — убрать."""

    username: str | None = None
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None

    @field_validator("username")
    @classmethod
    def username_valid(cls, v: str | None) -> str | None:
        return None if v is None else normalize_username(v)

    @field_validator("email")
    @classmethod
    def email_valid(cls, v: str | None) -> str | None:
        return normalize_email(v)

    @field_validator("first_name", "last_name")
    @classmethod
    def name_valid(cls, v: str | None) -> str | None:
        return normalize_person_name(v)


class UsernameCheckOut(BaseModel):
    available: bool
    # Почему нельзя: правило никнейма или «занят».
    reason: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    """Пользователь глазами других: почту не показываем."""

    id: str
    username: str
    phone: str
    first_name: str | None = None
    last_name: str | None = None
    display_name: str
    avatar_url: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class MeOut(UserOut):
    email: str | None = None

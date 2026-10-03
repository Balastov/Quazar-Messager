from datetime import datetime

from pydantic import BaseModel, field_validator

from app.core.phone import normalize_ru_phone


class UserRegister(BaseModel):
    username: str
    phone: str
    password: str

    @field_validator("username")
    @classmethod
    def username_valid(cls, v: str) -> str:
        if len(v) < 3 or len(v) > 64:
            raise ValueError("Username must be 3–64 characters")
        if not v.replace("_", "").replace(".", "").isalnum():
            raise ValueError("Username may only contain letters, digits, _ and .")
        return v

    @field_validator("phone")
    @classmethod
    def phone_valid(cls, v: str) -> str:
        return normalize_ru_phone(v)

    @field_validator("password")
    @classmethod
    def password_valid(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class UserLogin(BaseModel):
    phone: str
    password: str

    @field_validator("phone")
    @classmethod
    def phone_valid(cls, v: str) -> str:
        return normalize_ru_phone(v)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: str
    username: str
    phone: str
    avatar_url: str | None
    created_at: datetime

    model_config = {"from_attributes": True}

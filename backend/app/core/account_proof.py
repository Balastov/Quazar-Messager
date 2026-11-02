from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core import phone_verification
from app.core.security import verify_password
from app.models.user import User


class AccountProof(BaseModel):
    password: str | None = Field(default=None, max_length=256)
    reauth_code: str | None = Field(default=None, max_length=128)
    phone_proof: str | None = Field(default=None, max_length=128)


async def require_account_proof(db, user, proof):
    """Одноразовое свежее подтверждение; старый пароль не заменяет звонок/Яндекс после миграции."""
    from app.api.oauth import consume_reauth
    user = (await db.execute(select(User).where(User.id == user.id).with_for_update()
        .execution_options(populate_existing=True))).scalar_one()
    if user.phone_verified_at:
        if proof.phone_proof:
            await phone_verification.consume(db, user.phone, proof.phone_proof, purpose="reauth", user_id=user.id)
            return
        if await consume_reauth(db, user.id, proof.reauth_code):
            return
        raise HTTPException(status_code=403, detail="Подтвердите действие звонком или через привязанный Яндекс ID")
    if user.password_hash and verify_password(proof.password or "", user.password_hash):
        return
    if await consume_reauth(db, user.id, proof.reauth_code):
        return
    raise HTTPException(status_code=400 if user.password_hash else 403, detail="Неверное подтверждение аккаунта")

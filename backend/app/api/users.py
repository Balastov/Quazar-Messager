import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.avatars import (
    MAX_AVATAR_BYTES,
    delete_avatar_files,
    detect_image,
    save_avatar,
)
from app.core.backgrounds import (
    MAX_BACKGROUND_BYTES,
    BackgroundRejected,
    check_background,
    delete_background,
    save_background,
)
from app.core.accounts import TAKEN, email_taken, username_taken
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.e2e import decode_public_key_b64
from app.core.e2e_users import get_direct_chat_partner_ids
from app.core.phone import normalize_ru_phone
from app.core.security import verify_password
from app.models.user import User
from app.schemas.user import MeOut, UpdateProfile, UserOut
from app.ws.hub import manager
from app.core import presence

router = APIRouter(prefix="/users", tags=["users"])

BACKUP_PREFIX = "ENC_BACKUP:v1:"
MAX_BACKUP_LEN = 16_384


class UploadKeyBody(BaseModel):
    public_key: str  # base64-encoded X25519 public key (32 bytes)
    force: bool = False


class RotateKeyBody(BaseModel):
    # Пароль аккаунта; у аккаунта без пароля (через Яндекс) — код подтверждения через Яндекс.
    password: str | None = None
    reauth_code: str | None = None
    public_key: str


class KeyBackupBody(BaseModel):
    backup: str = Field(min_length=len(BACKUP_PREFIX) + 1, max_length=MAX_BACKUP_LEN)


class PublicKeyOut(BaseModel):
    user_id: str
    public_key: str | None
    public_key_updated_at: datetime | None = None


class KeyBackupOut(BaseModel):
    backup: str | None


async def _set_public_key_and_notify(
    current_user: User,
    public_key: str,
    db: AsyncSession,
    *,
    force_changed: bool,
) -> PublicKeyOut:
    try:
        decode_public_key_b64(public_key)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    key_changed = force_changed or (
        current_user.public_key is not None and current_user.public_key != public_key
    )

    current_user.public_key = public_key
    if key_changed or current_user.public_key_updated_at is None:
        current_user.public_key_updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(current_user)

    if key_changed:
        partner_ids = await get_direct_chat_partner_ids(current_user.id, db)
        # Свои же устройства тоже должны узнать, что ключ аккаунта сменился.
        await manager.broadcast_to_users(
            [*partner_ids, current_user.id],
            {
                "type": "key_changed",
                "user_id": current_user.id,
                "public_key": current_user.public_key,
                "updated_at": current_user.public_key_updated_at.isoformat(),
            },
        )

    return PublicKeyOut(
        user_id=current_user.id,
        public_key=current_user.public_key,
        public_key_updated_at=current_user.public_key_updated_at,
    )


@router.get("/me", response_model=MeOut)
async def get_me(current_user: Annotated[User, Depends(get_current_user)]):
    return current_user


@router.patch("/me", response_model=MeOut)
async def update_me(
    body: UpdateProfile,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Никнейм, почта, имя и фамилия. Собеседники в личных чатах узнают о смене сразу."""
    fields = body.model_fields_set
    if "username" in fields and body.username is None:
        raise HTTPException(status_code=422, detail="Никнейм обязателен")
    if body.username and body.username != current_user.username:
        if await username_taken(db, body.username, exclude_id=current_user.id):
            raise HTTPException(status_code=400, detail=TAKEN["username"])
        current_user.username = body.username
    if "email" in fields:
        if body.email and await email_taken(db, body.email, exclude_id=current_user.id):
            raise HTTPException(status_code=400, detail=TAKEN["email"])
        current_user.email = body.email
    if "first_name" in fields:
        current_user.first_name = body.first_name
    if "last_name" in fields:
        current_user.last_name = body.last_name
    if "phone_discoverable" in fields:
        if body.phone_discoverable is None:
            raise HTTPException(status_code=422, detail="Выберите «Да» или «Нет»")
        current_user.phone_discoverable = body.phone_discoverable

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Никнейм или почта уже заняты") from None
    await db.refresh(current_user)

    partner_ids = await get_direct_chat_partner_ids(current_user.id, db)
    await manager.broadcast_to_users(
        [*partner_ids, current_user.id],
        {"type": "user_updated", "user": UserOut.model_validate(current_user).model_dump(mode="json")},
    )
    return current_user


@router.post("/me/avatar", response_model=MeOut)
async def upload_avatar(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    file: Annotated[UploadFile, File(...)],
):
    """Загружает аватар пользователя (JPEG/PNG/WebP/GIF, до 3 МБ)."""
    data = await file.read(MAX_AVATAR_BYTES + 1)
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Avatar must be at most 3 MB")
    if not data:
        raise HTTPException(status_code=422, detail="Empty file")

    detected = detect_image(data)
    if not detected:
        raise HTTPException(
            status_code=422,
            detail="Unsupported image type. Use JPEG, PNG, WebP or GIF.",
        )
    _content_type, ext = detected

    try:
        url = save_avatar(current_user.id, data, ext)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    current_user.avatar_url = url
    await db.commit()
    await db.refresh(current_user)
    return current_user


class BackgroundOut(BaseModel):
    background_url: str | None


async def _background_changed(user: User) -> BackgroundOut:
    """Личный фон меняется сразу на всех устройствах пользователя."""
    await manager.send_to_user(
        user.id, {"type": "user_background", "background_url": user.background_url}
    )
    return BackgroundOut(background_url=user.background_url)


@router.get("/me/background", response_model=BackgroundOut)
async def get_my_background(current_user: Annotated[User, Depends(get_current_user)]):
    return BackgroundOut(background_url=current_user.background_url)


@router.post("/me/background", response_model=BackgroundOut)
async def upload_my_background(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    file: Annotated[UploadFile, File(...)],
):
    """Личный фон приложения (JPEG/PNG/WebP/GIF, до 5 МБ)."""
    data = await file.read(MAX_BACKGROUND_BYTES + 1)
    try:
        ext = check_background(data)
    except BackgroundRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None
    old = current_user.background_url
    current_user.background_url = save_background(data, ext)
    await db.commit()
    delete_background(old)
    return await _background_changed(current_user)


@router.delete("/me/background", response_model=BackgroundOut)
async def remove_my_background(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    old = current_user.background_url
    current_user.background_url = None
    await db.commit()
    delete_background(old)
    return await _background_changed(current_user)


@router.delete("/me/avatar", response_model=MeOut)
async def remove_avatar(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    delete_avatar_files(current_user.id)
    current_user.avatar_url = None
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.put("/me/key", response_model=PublicKeyOut)
async def upload_public_key(
    body: UploadKeyBody,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Загружает публичный X25519-ключ пользователя (используется для E2E шифрования)."""
    if (
        current_user.public_key
        and current_user.public_key != body.public_key
        and not body.force
    ):
        raise HTTPException(
            status_code=409,
            detail="Public key already set. Use force=true to rotate.",
        )

    return await _set_public_key_and_notify(
        current_user,
        body.public_key,
        db,
        force_changed=bool(
            current_user.public_key and current_user.public_key != body.public_key
        ),
    )


@router.post("/me/key/rotate", response_model=PublicKeyOut)
async def rotate_public_key(
    body: RotateKeyBody,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Ротация публичного ключа с подтверждением паролем аккаунта (или через Яндекс, если пароля нет):
    одной украденной сессии мало, чтобы подменить ключ шифрования."""
    from app.api.oauth import consume_reauth

    if current_user.password_hash:
        if not verify_password(body.password or "", current_user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid password")
    elif not await consume_reauth(db, current_user.id, body.reauth_code):
        raise HTTPException(status_code=403, detail="Подтвердите, что это вы, через Яндекс ID")

    # Резервная копия содержит старый ключ — другим устройствам она больше не поможет.
    current_user.key_backup = None

    return await _set_public_key_and_notify(
        current_user,
        body.public_key,
        db,
        force_changed=True,
    )


@router.put("/me/key-backup", response_model=KeyBackupOut)
async def save_key_backup(
    body: KeyBackupBody,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Сохраняет зашифрованную резервную копию ключей (сервер хранит только ciphertext)."""
    if not body.backup.startswith(BACKUP_PREFIX):
        raise HTTPException(status_code=422, detail="Invalid backup format")

    current_user.key_backup = body.backup
    await db.commit()
    return KeyBackupOut(backup=current_user.key_backup)


@router.get("/me/key-backup", response_model=KeyBackupOut)
async def get_key_backup(current_user: Annotated[User, Depends(get_current_user)]):
    return KeyBackupOut(backup=current_user.key_backup)


@router.get("/search", response_model=list[UserOut])
async def search_users(
    q: Annotated[str, Query(min_length=1, max_length=64)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Поиск по никнейму, имени и фамилии; по номеру (+7…) — только целиком и только тех,
    кто разрешил находить себя по номеру."""
    query = q.strip()
    if len(query) < 2 and len(re.sub(r"\D", "", query)) < 3:
        raise HTTPException(status_code=422, detail="Query too short")

    conditions = []
    if len(query) >= 2:
        like = f"%{query.lstrip('@')}%"
        conditions.append(User.username.ilike(like))
        conditions.append(User.first_name.ilike(like))
        conditions.append(User.last_name.ilike(like))
    # По кусочку номера не ищем: так перебором находились бы и чужие номера.
    try:
        phone = normalize_ru_phone(query)
    except ValueError:
        phone = None
    if phone:
        conditions.append((User.phone == phone) & User.phone_discoverable.is_(True))

    if not conditions:
        return []

    result = await db.execute(
        select(User)
        .where(or_(*conditions), User.id != current_user.id, User.is_official.is_(False))
        .order_by(User.username.asc())
        .limit(20)
    )
    return result.scalars().all()


@router.get("/{user_id}/key", response_model=PublicKeyOut)
async def get_public_key(
    user_id: str,
    _: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Возвращает публичный ключ пользователя для установки E2E-сессии."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return PublicKeyOut(
        user_id=user.id,
        public_key=user.public_key,
        public_key_updated_at=user.public_key_updated_at,
    )


class ManualStatusIn(BaseModel):
    # None — снять статус.
    kind: Literal["meeting", "dnd"] | None = None
    # До какого момента; None — пока не снимут.
    until: datetime | None = None


class ManualStatusOut(BaseModel):
    kind: str | None
    until: datetime | None


@router.put("/me/status", response_model=ManualStatusOut)
async def set_my_status(
    body: ManualStatusIn,
    current_user: Annotated[User, Depends(get_current_user)],
):
    """«На встрече» / «Не беспокоить» с таймером — виден собеседникам вместо «отошёл(ла)»."""
    until = body.until
    if body.kind and until is not None:
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if until <= now:
            raise HTTPException(status_code=422, detail="Время окончания уже прошло")
        if until - now > timedelta(days=7):
            raise HTTPException(status_code=422, detail="Не дольше недели")
    manual = await presence.set_manual(current_user.id, body.kind, until if body.kind else None)
    return ManualStatusOut(kind=manual["kind"] if manual else None, until=until if manual else None)


class CustomStatusIn(BaseModel):
    # Имя значка из набора клиента (Lucide): «coffee», «plane»…
    icon: str | None = Field(default=None, pattern=r"^[a-z0-9-]{1,40}$")
    text: str = Field(default="", max_length=80)
    # До какого момента; None — пока не снимут.
    until: datetime | None = None


class CustomStatusOut(BaseModel):
    icon: str | None
    text: str
    until: datetime | None


@router.put("/me/custom-status", response_model=CustomStatusOut | None)
async def set_my_custom_status(
    body: CustomStatusIn,
    current_user: Annotated[User, Depends(get_current_user)],
):
    """Свой статус: значок, текст и «до». Только подпись — уведомления и звонки он не трогает.
    Пустые значок и текст — снять."""
    text = " ".join(body.text.split())
    if not body.icon and not text:
        await presence.set_custom(current_user.id, None)
        return None
    until = body.until
    if until is not None:
        if until.tzinfo is None:
            raise HTTPException(status_code=422, detail="Время — с часовым поясом")
        now = datetime.now(timezone.utc)
        if until <= now:
            raise HTTPException(status_code=422, detail="Время окончания уже прошло")
        if until - now > timedelta(days=365):
            raise HTTPException(status_code=422, detail="Не дальше чем на год")
    await presence.set_custom(
        current_user.id, {"icon": body.icon, "text": text, "until": until.isoformat() if until else None}
    )
    return CustomStatusOut(icon=body.icon, text=text, until=until)

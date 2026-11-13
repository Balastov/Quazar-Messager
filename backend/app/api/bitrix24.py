"""Stage 1: installation and a verified, single-use launch into an isolated frame."""
import re
import secrets
import ipaddress
from datetime import datetime, timedelta, timezone
from typing import Annotated
from urllib.parse import parse_qs, urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import bitrix24 as b24
from app.core.config import settings
from app.core.device_pairing import rate_limit
from app.core.database import get_db
from app.models.bitrix24 import BitrixCredential, BitrixHandoff, BitrixInstallation

router = APIRouter(prefix="/integrations/bitrix24", tags=["bitrix24"])
Db = Annotated[AsyncSession, Depends(get_db)]


async def _form(request: Request) -> dict[str, str]:
    if request.headers.get("content-type", "").split(";")[0] != "application/x-www-form-urlencoded":
        raise HTTPException(415, "Б24 должен передать форму запуска")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 16384:
            raise HTTPException(413, "Слишком большой запрос запуска")
    try:
        values = parse_qs(raw.decode("utf-8"), max_num_fields=64, keep_blank_values=True)
        if any(len(v) != 1 for v in values.values()):
            raise ValueError()
        return {k: v[0] for k, v in values.items()}
    except (UnicodeError, ValueError):
        raise HTTPException(422, "Некорректная форма запуска") from None


async def _launch(request: Request, db: AsyncSession, *, installing: bool):
    b24.require_enabled()
    data = await _form(request)
    # Endpoint and origin are never built from untrusted request parameters.
    domain = data.get("DOMAIN") or request.query_params.get("DOMAIN", "")
    if domain != b24.origin().removeprefix("https://"):
        raise HTTPException(403, "Этот портал Б24 не подключён")
    member = data.get("member_id", "")
    app_token = data.get("APPLICATION_TOKEN", "")
    refresh = data.get("REFRESH_ID", "")
    app_sid = data.get("APP_SID") or request.query_params.get("APP_SID", "")
    if (not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", member)
            or not 16 <= len(app_token) <= 512 or not 16 <= len(refresh) <= 2048
            or not re.fullmatch(r"[A-Za-z0-9_.-]{1,256}", app_sid)):
        raise HTTPException(422, "Не хватает данных запуска. Откройте Квазар из меню Б24")
    ip = request.client.host if request.client else "unknown"
    if settings.TRUST_PROXY_REAL_IP:
        try:
            ip = str(ipaddress.ip_address(request.headers.get("x-real-ip", "")))
        except ValueError:
            pass
    await rate_limit(db, "b24-launch-ip", ip, limit=120)
    await rate_limit(db, "b24-launch-proof", refresh, limit=6)
    connection = (await db.execute(select(BitrixInstallation).where(
        BitrixInstallation.origin == b24.origin()).with_for_update())).scalar_one_or_none()
    if connection:
        if connection.member_id != member or not secrets.compare_digest(
                connection.application_token_hash, b24.digest(app_token)):
            raise HTTPException(403, "Не совпадает подключение Б24. Проверьте настройки приложения")
    elif not installing:
        raise HTTPException(409, "Сначала установите Квазар в Б24")
    verified = await b24.verify_launch(refresh, member, installation=installing)
    if not connection:
        connection = BitrixInstallation(origin=b24.origin(), member_id=member,
                                       application_token_hash=b24.digest(app_token))
        db.add(connection)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "Установка уже выполняется. Повторите открытие приложения") from None
    credential = (await db.execute(select(BitrixCredential).where(
        BitrixCredential.installation_id == connection.id,
        BitrixCredential.employee_id == verified.employee_id))).scalar_one_or_none()
    if not credential:
        credential = BitrixCredential(installation_id=connection.id, employee_id=verified.employee_id)
        db.add(credential)
    credential.tokens = b24.encrypt_tokens(verified.tokens)
    credential.expires_at = verified.expires_at
    await db.flush()
    now = datetime.now(timezone.utc)
    await db.execute(delete(BitrixHandoff).where(BitrixHandoff.expires_at < now))
    code = secrets.token_urlsafe(32)
    db.add(BitrixHandoff(code_hash=b24.digest(code), credential_id=credential.id,
                        display_name=verified.display_name, mode="install" if installing else "launch",
                        expires_at=now + timedelta(seconds=60)))
    await db.commit()
    # Only a short-lived single-use handoff goes in the fragment, never OAuth tokens.
    query = urlencode({"DOMAIN": domain, "PROTOCOL": "1", "APP_SID": app_sid})
    return RedirectResponse(f"{settings.BITRIX24_PUBLIC_PREFIX}/bitrix24.html?{query}#code={code}", status_code=303,
                            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.post("/install")
async def install(request: Request, db: Db):
    return await _launch(request, db, installing=True)


@router.post("/launch")
async def launch(request: Request, db: Db):
    return await _launch(request, db, installing=False)


class ExchangeBody(BaseModel):
    code: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]+$")


@router.post("/exchange")
async def exchange(body: ExchangeBody, db: Db):
    b24.require_enabled()
    row = (await db.execute(delete(BitrixHandoff).where(
        BitrixHandoff.code_hash == b24.digest(body.code),
        BitrixHandoff.expires_at > datetime.now(timezone.utc)).returning(
            BitrixHandoff.credential_id, BitrixHandoff.display_name, BitrixHandoff.mode))).first()
    if not row:
        raise HTTPException(410, "Запуск устарел. Откройте Квазар из меню Б24 заново")
    credential = await db.get(BitrixCredential, row.credential_id)
    connection = await db.get(BitrixInstallation, credential.installation_id)
    if connection.origin != b24.origin():
        raise HTTPException(403, "Подключение Б24 изменилось")
    await db.commit()
    # This stage grants no Quazar login and exposes no OAuth tokens or phone/email.
    return JSONResponse({"portal": connection.origin, "employee_id": credential.employee_id,
                         "display_name": row.display_name, "mode": row.mode,
                         "account_linking_available": False}, headers={"Cache-Control": "no-store"})

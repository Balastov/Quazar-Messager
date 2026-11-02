"""Входящая проверка номера через Звонок. Секрет и ответы провайдера не попадают в ошибки API."""

from dataclasses import dataclass
from datetime import datetime
import logging
import re

import httpx

from app.core.config import settings
from app.core.phone import normalize_ru_phone

BASE = "https://zvonok.com/manager/cabapi_external/api/v1/phones/"


class _RedactKey(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        if "zvonok.com" in message and "public_key=" in message:
            record.msg = re.sub(r"public_key=[^&\s\"]+", "public_key=[redacted]", message)
            record.args = ()
        return True


logging.getLogger("httpx").addFilter(_RedactKey())


class ProviderError(Exception):
    pass


def required() -> bool:
    # Частично заданная конфигурация тоже требует проверки, а не открывает регистрацию.
    return bool(settings.ZVONOK_API_KEY.strip() or settings.ZVONOK_CAMPAIGN_ID.strip())


def configured() -> bool:
    return bool(settings.ZVONOK_API_KEY.strip() and settings.ZVONOK_CAMPAIGN_ID.strip())


@dataclass
class Confirmation:
    call_id: str
    call_phone: str
    created_at: datetime


async def create(phone: str, *, transport=None) -> Confirmation:
    if not configured():
        raise ProviderError()
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False, transport=transport) as client:
            response = await client.post(BASE + "confirm/", data={
                "public_key": settings.ZVONOK_API_KEY, "campaign_id": settings.ZVONOK_CAMPAIGN_ID,
                "phone": phone,
            })
            response.raise_for_status()
            body = response.json()
        data = body["data"]
        if body.get("status") != "ok" or not str(data.get("call_id", "")).isdigit():
            raise ProviderError()
        # Реальный ответ pincode_incoming: phone — номер клиента,
        # allowed_phones_for_call — номера, на которые клиент должен позвонить.
        destinations = data.get("allowed_phones_for_call")
        if not isinstance(destinations, list) or not destinations:
            raise ProviderError()
        call_phone = normalize_ru_phone(str(destinations[0]))
        if call_phone == phone:
            raise ProviderError()
        created_at = datetime.fromisoformat(data["created"].replace("Z", "+00:00"))
        if created_at.tzinfo is None:
            raise ProviderError()
        return Confirmation(call_id=str(data["call_id"]), call_phone=call_phone, created_at=created_at)
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        raise ProviderError() from None


async def result(call_id: str, phone: str, *, transport=None) -> str:
    if not configured():
        raise ProviderError()
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False, transport=transport) as client:
            response = await client.get(BASE + "call_by_id/", params={
                "public_key": settings.ZVONOK_API_KEY, "call_id": call_id,
            })
            response.raise_for_status()
            rows = response.json()
        if not isinstance(rows, list) or len(rows) != 1:
            raise ProviderError()
        row = rows[0]
        if str(row.get("call_id")) != call_id or normalize_ru_phone(str(row.get("phone"))) != phone:
            raise ProviderError()
        # Актуальное поле call_status; status устарело. Ответил/завершено/IVR не доказывают проверку.
        status = row.get("call_status")
        if status == "pincode_ok":
            return "verified"
        if status in {"pincode_nook", "expires", "deleted", "interrupted", "inactive_number", "no_provider", "attempts_exc"}:
            return "failed"
        return "pending"
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        raise ProviderError() from None

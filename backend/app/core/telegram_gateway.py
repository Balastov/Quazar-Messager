"""Код подтверждения в Telegram через Telegram Gateway (https://core.telegram.org/gateway/api).

Код генерируем и проверяем сами; Gateway только доставляет его. Токен и ответы
провайдера не попадают в ошибки API и логи."""

import logging

import httpx

from app.core.config import settings

BASE = "https://gatewayapi.telegram.org/"
log = logging.getLogger(__name__)


class ProviderError(Exception):
    pass


class Undeliverable(ProviderError):
    """Gateway отказался отправлять: у номера нет Telegram или он не принимает коды."""


# Ошибки Gateway про сам запрос и аккаунт — значит, сломана наша настройка, а не номер человека.
OUR_FAULT = ("ACCESS_TOKEN", "BALANCE", "SENDER", "CALLBACK", "TTL", "CODE_", "PAYLOAD", "FLOOD", "INTERNAL")


def configured() -> bool:
    return bool(settings.TELEGRAM_GATEWAY_TOKEN.strip())


async def _call(method: str, payload: dict, *, transport=None) -> dict:
    if not configured():
        raise ProviderError()
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False, transport=transport) as client:
            response = await client.post(BASE + method, json=payload,
                headers={"Authorization": "Bearer " + settings.TELEGRAM_GATEWAY_TOKEN.strip()})
            body = response.json()
    except (httpx.HTTPError, ValueError):
        raise ProviderError() from None
    if not isinstance(body, dict):
        raise ProviderError()
    if body.get("ok") is True and isinstance(body.get("result"), dict):
        return body["result"]
    error = str(body.get("error") or "")[:64]
    log.warning("Telegram Gateway %s failed: %s", method, error or response.status_code)
    if error and not error.upper().startswith(OUR_FAULT) and response.status_code < 500:
        raise Undeliverable()
    raise ProviderError()


async def send_code(phone: str, code: str, ttl: int, *, transport=None) -> str:
    """Отправляет код; возвращает request_id. Недоставленный за ttl код Telegram не тарифицирует."""
    payload = {"phone_number": phone, "code": code, "ttl": ttl}
    if settings.TELEGRAM_GATEWAY_SENDER.strip():
        payload["sender_username"] = settings.TELEGRAM_GATEWAY_SENDER.strip().lstrip("@")
    result = await _call("sendVerificationMessage", payload, transport=transport)
    request_id = result.get("request_id")
    if not isinstance(request_id, str) or not request_id or len(request_id) > 60:
        raise ProviderError()
    return request_id


async def report_code(request_id: str, code: str, *, transport=None) -> None:
    """Сообщает Gateway введённый код — только для его статистики; решение принимаем сами."""
    try:
        await _call("checkVerificationStatus", {"request_id": request_id, "code": code}, transport=transport)
    except ProviderError:
        pass

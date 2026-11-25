"""Журнал авторизации: входы, выходы, отзывы и отказы в сессии.

Нужен, чтобы понять, почему человеку пришлось войти заново: сервер отказал сессии (и по какой
причине) или устройство само потеряло вход (сервер отказа не видел, а следующий вход — с того же
устройства при ещё действующей прежней сессии). Хранится settings.AUTH_LOG_DAYS дней.

Запись идёт отдельной транзакцией на том же подключении к базе: отказ в сессии заканчивается 401,
и транзакция запроса откатывается — запись журнала при этом остаться должна. Ошибка записи вход
не ломает.
"""
import logging
import time
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from urllib.parse import parse_qs

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.auth_event import AuthEvent
from app.models.device import DeviceSession

log = logging.getLogger(__name__)

# Подписи для «Чёрной дыры». Код причины хранится в auth_events.reason.
LOGIN_METHODS = {
    "password": "Пароль",
    "register": "Регистрация",
    "yandex": "Яндекс ID",
    "yandex_register": "Регистрация через Яндекс ID",
    "phone_call": "Звонок на телефон",
    "phone_verified": "Подтвердил телефон (новый токен)",
    "login_code": "Код в чате с другого устройства",
    "device_pairing": "QR-код / подтверждение с другого устройства",
    "password_changed": "Сменил пароль (новый токен)",
    "password_reset": "Пароль из поддержки (новый токен)",
    "unknown": "Токен, выданный до появления журнала",
}
REJECT_REASONS = {
    "bad_token": "Токен не читается: повреждён или сменился секрет сервера",
    "user_missing": "Аккаунт удалён",
    "blocked": "Аккаунт заблокирован",
    "password_changed": "Сменили пароль — прежние входы завершены",
    "sessions_revoked": "Все входы завершены (подтверждение телефона или «Выйти на других устройствах»)",
    "token_expired": "Старый токен без записи сессии: истёк до первого захода",
    "session_missing": "Записи сессии нет (удалена после истечения)",
    "session_revoked": "Этот вход завершён (выход или отзыв — см. запись выше)",
    "session_expired": f"Не заходили {settings.SESSION_IDLE_DAYS} дней",
    "session_mismatch": "Токен не совпадает с записью сессии",
}
LOGOUT_REASONS = {
    "button": "Нажал «Выйти»",
    "forget_device": "«Выйти и забыть устройство»",
    "device_list": "Завершил этот вход в списке устройств",
    "switch_account": "Сменил аккаунт при входе через Quazar",
    "device_connect": "Вышел, чтобы подключить устройство к другому аккаунту",
    # Приложение получило 401 и вышло, а сессия при этом жива: 401 пришёл не от проверки сессии.
    "rejected": "Приложение вышло после ответа 401, хотя вход действовал",
    "unknown": "Причина не указана (старая версия приложения)",
}
REVOKE_REASONS = {
    "device_list": "Завершён с другого устройства (список устройств)",
    "others": "«Выйти на других устройствах»",
    "pairing_denied": "«Это не я» на другом устройстве",
    "phone_verified": "Подтвердил телефон — завершены все прежние входы",
}
LOGIN_FAILED_REASONS = {
    "wrong_password": "Неверный пароль",
    "use_phone": "Пароль отключён: телефон подтверждён",
    "blocked": "Аккаунт заблокирован",
}
LABELS = {"login": LOGIN_METHODS, "rejected": REJECT_REASONS, "logout": LOGOUT_REASONS,
          "revoked": REVOKE_REASONS, "login_failed": LOGIN_FAILED_REASONS}

# Повторы одного и того же отказа (параллельные запросы при запуске, переподключения) — не чаще раза в 10 минут.
DEDUPE_SEC = 600
_recent: dict[tuple, float] = {}
_last_cleanup = 0.0

# Начало пометки у входа, когда прежний вход на похожем устройстве ещё действовал (по ней считает сводка).
LOST_ON_DEVICE = "На похожем устройстве"

_request: ContextVar[dict | None] = ContextVar("auth_log_request", default=None)


def now() -> datetime:
    return datetime.now(timezone.utc)


def label(event: str, reason: str | None) -> str:
    return LABELS.get(event, {}).get(reason or "", reason or "")


class RequestContext:
    """ASGI-обёртка: запоминает IP, браузер, приложение и путь запроса для записей журнала."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.lower(): v for k, v in scope.get("headers") or []}
        text = lambda name: headers.get(name, b"").decode("latin-1")  # noqa: E731
        ip = None
        if settings.TRUST_PROXY_REAL_IP:
            try:
                ip = str(ip_address(text(b"x-real-ip")))
            except ValueError:
                ip = None
        if ip is None and scope.get("client"):
            ip = scope["client"][0]
        method = "WS" if scope["type"] == "websocket" else scope.get("method", "")
        client = text(b"x-quazar-client")
        if not client and scope["type"] == "websocket":
            # Браузер не даёт ставить заголовки WebSocket — приложение присылает себя в ?client=.
            client = (parse_qs(scope.get("query_string", b"").decode("latin-1")).get("client") or [""])[0]
        token = _request.set({"ip": ip, "user_agent": text(b"user-agent")[:300] or None,
                              "client": client[:32] or None,
                              "path": f"{method} {scope.get('path', '')}"[:120]})
        try:
            await self.app(scope, receive, send)
        finally:
            _request.reset(token)


def _seen_recently(key: tuple) -> bool:
    moment = time.monotonic()
    if _recent.get(key, 0) > moment:
        return True
    if len(_recent) > 10_000:
        for old in [k for k, until in _recent.items() if until <= moment]:
            del _recent[old]
    _recent[key] = moment + DEDUPE_SEC
    return False


async def record(db: AsyncSession, event: str, *, user_id: str | None = None, session_id: str | None = None,
                 reason: str | None = None, detail: str | None = None, dedupe: str | None = None) -> None:
    """Пишет событие. db — сессия запроса: берём у неё только подключение, транзакция своя."""
    if dedupe is not None and _seen_recently((event, reason, dedupe)):
        return
    context = _request.get() or {}
    try:
        async with AsyncSession(db.bind, expire_on_commit=False) as own:
            own.add(AuthEvent(at=now(), user_id=user_id, session_id=session_id, event=event, reason=reason,
                              detail=(detail or None) and detail[:300], ip=context.get("ip"),
                              user_agent=context.get("user_agent"), client=context.get("client"),
                              path=context.get("path")))
            await own.commit()
    except Exception:  # noqa: BLE001 — журнал не должен ломать вход
        log.exception("auth log: failed to record %s/%s", event, reason)


def when(value: datetime | None) -> str:
    return value.astimezone(timezone.utc).strftime("%d.%m.%Y %H:%M UTC") if value else "—"


async def login(db: AsyncSession, user_id: str, session_id: str | None, method: str, device: str) -> None:
    """Вход. Если на похожем устройстве ещё есть действующий вход, устройство, скорее всего,
    потеряло прежний токен само (стёрлось хранилище браузера) — сервер его не завершал."""
    detail = None
    try:
        async with AsyncSession(db.bind, expire_on_commit=False) as own:
            previous = (await own.execute(select(DeviceSession).where(
                DeviceSession.user_id == user_id, DeviceSession.name == device, DeviceSession.revoked_at.is_(None),
                DeviceSession.expires_at > now(), DeviceSession.id != (session_id or ""),
            ).order_by(DeviceSession.last_seen_at.desc()).limit(1))).scalar_one_or_none()
            if previous:
                detail = (f"{LOST_ON_DEVICE} ({device}) ещё действует вход от {when(previous.created_at)}, "
                          f"последний заход {when(previous.last_seen_at)}: прежний вход потерян на устройстве, сервер его не завершал")
    except Exception:  # noqa: BLE001
        log.exception("auth log: failed to look up previous session")
    await record(db, "login", user_id=user_id, session_id=session_id,
                 reason=method if method in LOGIN_METHODS else "unknown", detail=detail)


async def rejected(db: AsyncSession, reason: str, *, token_hash: str, user_id: str | None = None,
                   session_id: str | None = None, detail: str | None = None) -> None:
    await record(db, "rejected", user_id=user_id, session_id=session_id, reason=reason, detail=detail, dedupe=token_hash)


def cutoff_reason(user) -> tuple[str, str]:
    """Почему токен старше отсечки: сменили пароль или завершили все входы."""
    changed, revoked = user.password_changed_at, user.sessions_revoked_at
    if changed and (not revoked or changed >= revoked):
        return "password_changed", f"Пароль сменён {when(changed)}"
    return "sessions_revoked", f"Все входы завершены {when(revoked)}"


async def cleanup(db: AsyncSession) -> int:
    """Старше AUTH_LOG_DAYS — удаляем. Планировщик зовёт каждые 5 секунд, работаем раз в час."""
    global _last_cleanup
    if time.monotonic() - _last_cleanup < 3600:
        return 0
    _last_cleanup = time.monotonic()
    result = await db.execute(delete(AuthEvent).where(AuthEvent.at < now() - timedelta(days=settings.AUTH_LOG_DAYS)))
    await db.commit()
    return result.rowcount


def reset_for_tests() -> None:
    global _last_cleanup
    _recent.clear()
    _last_cleanup = 0.0

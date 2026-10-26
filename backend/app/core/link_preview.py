"""Превью ссылок: заголовок, описание, сайт и картинка со страницы (Open Graph / <title>).

Страницу открывает сервер по просьбе отправителя — переписку он при этом не видит: в личных
чатах превью потом уходит внутри зашифрованного сообщения, получатели сайт не открывают.

Защита: только http(s) и только публичные адреса (каждый редирект проверяется заново), не больше
MAX_HTML байт страницы и MAX_IMAGE байт картинки, короткие таймауты, кэш на час.
"""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import logging
import socket
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpx

log = logging.getLogger(__name__)

MAX_HTML = 512 * 1024
MAX_IMAGE = 1024 * 1024
MAX_REDIRECTS = 3
TIMEOUT = httpx.Timeout(5.0, connect=3.0)
CACHE_TTL = 3600
CACHE_SIZE = 500
USER_AGENT = "Mozilla/5.0 (compatible; QuazarBot/1.0; +https://quazar-msg.ru)"
IMAGE_SIGNATURES = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)

_cache: dict[str, tuple[float, dict | None]] = {}


class Blocked(Exception):
    """Адрес не публичный или не http(s)."""


def _check_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Blocked("Только ссылки http и https")
    if parts.username or parts.password:
        raise Blocked("Ссылки с логином не открываем")
    return parts.hostname


async def _assert_public(host: str) -> None:
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise Blocked("Сайт не найден") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise Blocked("Внутренние адреса не открываем")


async def _get(client: httpx.AsyncClient, url: str, limit: int) -> tuple[str, str, bytes]:
    """GET с проверкой каждого редиректа. Возвращает (итоговый адрес, content-type, тело до limit)."""
    for _ in range(MAX_REDIRECTS + 1):
        await _assert_public(_check_url(url))
        async with client.stream("GET", url) as resp:
            if resp.is_redirect and resp.headers.get("location"):
                url = urljoin(url, resp.headers["location"])
                continue
            if resp.status_code >= 400:
                raise Blocked(f"Сайт ответил {resp.status_code}")
            body = bytearray()
            async for chunk in resp.aiter_bytes():
                body += chunk
                if len(body) >= limit:
                    break
            return url, resp.headers.get("content-type", ""), bytes(body[:limit])
    raise Blocked("Слишком много переадресаций")


class _Meta(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and len(self.title) < 300:
            self.title += data


def _clean(text: str | None, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def parse_html(html: str, base_url: str) -> dict:
    parser = _Meta()
    try:
        parser.feed(html)
    except Exception:  # noqa: BLE001 — кривой HTML не повод падать
        pass
    m = parser.meta
    image = m.get("og:image") or m.get("og:image:url") or m.get("twitter:image")
    return {
        "url": base_url,
        "title": _clean(m.get("og:title") or m.get("twitter:title") or parser.title, 200),
        "description": _clean(m.get("og:description") or m.get("twitter:description") or m.get("description"), 300),
        "site": _clean(m.get("og:site_name") or urlsplit(base_url).hostname, 100),
        "image_url": urljoin(base_url, image) if image else None,
    }


def _decode(body: bytes, content_type: str) -> str:
    charset = "utf-8"
    if "charset=" in content_type:
        charset = content_type.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


async def fetch_preview(url: str, transport: httpx.AsyncBaseTransport | None = None) -> dict | None:
    """Превью или None (страница без заголовка, не HTML, недоступна). Blocked — адрес запрещён.
    transport — для тестов."""
    _check_url(url)
    now = time.monotonic()
    cached = _cache.get(url)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    result = None
    async with httpx.AsyncClient(
        timeout=TIMEOUT, follow_redirects=False, headers={"User-Agent": USER_AGENT}, transport=transport
    ) as client:
        try:
            final, ctype, body = await _get(client, url, MAX_HTML)
            if "html" in ctype.lower():
                data = parse_html(_decode(body, ctype), final)
                if data["title"]:
                    data["image"] = await _image(client, data.pop("image_url"))
                    data["url"] = url
                    result = data
        except Blocked:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            log.info("link preview %s failed: %s", url[:80], exc)
    if len(_cache) >= CACHE_SIZE:
        _cache.pop(next(iter(_cache)))
    _cache[url] = (now, result)
    return result


async def _image(client: httpx.AsyncClient, url: str | None) -> str | None:
    """Картинка страницы как data: URL — клиент уменьшит её сам. Только JPEG/PNG/GIF по сигнатуре."""
    if not url:
        return None
    try:
        _, _, body = await _get(client, url, MAX_IMAGE + 1)
    except (Blocked, httpx.HTTPError, ValueError):
        return None
    if len(body) > MAX_IMAGE:
        return None
    mime = next((m for sig, m in IMAGE_SIGNATURES if body.startswith(sig)), None)
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        mime = "image/webp"
    if not mime:
        return None
    return f"data:{mime};base64,{base64.b64encode(body).decode()}"


def reset() -> None:
    _cache.clear()

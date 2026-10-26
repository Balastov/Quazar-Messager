"""Превью ссылок: разбор страницы, картинка, защита от внутренних адресов."""

import base64
import unittest
from unittest import mock

import httpx

from app.core import link_preview as lp

# Настоящая проверка адреса — до подмены в setUp.
REAL_ASSERT_PUBLIC = lp._assert_public

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
PAGE = """<html><head><title>Запасной заголовок</title>
<meta property="og:title" content="Квартальный  отчёт &amp; планы">
<meta name="description" content="Описание страницы">
<meta property="og:image" content="/img/cover.png">
<meta property="og:site_name" content="Пример">
</head><body>…</body></html>"""


def handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if request.url.host == "redirect.test":
        return httpx.Response(302, headers={"location": "http://internal.test/admin"})
    if path == "/img/cover.png":
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
    if path == "/file.zip":
        return httpx.Response(200, content=b"PK..", headers={"content-type": "application/zip"})
    return httpx.Response(200, text=PAGE, headers={"content-type": "text/html; charset=utf-8"})


async def fake_public(host: str) -> None:
    if host in ("internal.test", "localhost") or host.startswith("127.") or host.startswith("10."):
        raise lp.Blocked("Внутренние адреса не открываем")


class LinkPreviewTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        lp.reset()
        patcher = mock.patch.object(lp, "_assert_public", fake_public)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.transport = httpx.MockTransport(handler)

    async def test_open_graph_and_image(self):
        out = await lp.fetch_preview("https://site.test/report", transport=self.transport)
        self.assertEqual((out["title"], out["description"], out["site"]), ("Квартальный отчёт & планы", "Описание страницы", "Пример"))
        self.assertEqual(out["image"], "data:image/png;base64," + base64.b64encode(PNG).decode())
        self.assertEqual(out["url"], "https://site.test/report")

    async def test_not_html_and_blocked_addresses(self):
        self.assertIsNone(await lp.fetch_preview("https://site.test/file.zip", transport=self.transport))
        for url in ("ftp://site.test/x", "http://user:pw@site.test/", "http://127.0.0.1:8000/docs", "http://localhost/"):
            with self.assertRaises(lp.Blocked):
                await lp.fetch_preview(url, transport=self.transport)
        # Редирект на внутренний адрес тоже не пройдёт.
        with self.assertRaises(lp.Blocked):
            await lp.fetch_preview("http://redirect.test/", transport=self.transport)

    async def test_real_resolver_blocks_private_ips(self):
        for host in ("127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "localhost"):
            with self.assertRaises(lp.Blocked):
                await REAL_ASSERT_PUBLIC(host)

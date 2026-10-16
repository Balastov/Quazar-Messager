import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class FakeDb:
    """Отдаёт заранее заданные результаты по порядку запросов: сообщения, затем звонки."""

    def __init__(self, *results):
        self._results = list(results)

    async def execute(self, _query):
        return FakeResult(self._results.pop(0))


class TestChatLastActivity(unittest.IsolatedAsyncioTestCase):
    async def test_picks_latest_of_message_call_and_creation(self):
        from app.api.chats import _attach_last_activity

        t0 = datetime(2026, 10, 1, tzinfo=timezone.utc)
        quiet = SimpleNamespace(id="quiet", created_at=t0 + timedelta(days=5))
        texted = SimpleNamespace(id="texted", created_at=t0)
        called = SimpleNamespace(id="called", created_at=t0)

        db = FakeDb(
            [("texted", t0 + timedelta(days=7)), ("called", t0 + timedelta(days=1))],
            [("called", t0 + timedelta(days=9))],
        )
        chats = [quiet, texted, called]
        await _attach_last_activity(chats, db)

        self.assertEqual(quiet.last_activity_at, t0 + timedelta(days=5))
        self.assertEqual(texted.last_activity_at, t0 + timedelta(days=7))
        self.assertEqual(called.last_activity_at, t0 + timedelta(days=9))

        chats.sort(key=lambda c: c.last_activity_at, reverse=True)
        self.assertEqual([c.id for c in chats], ["called", "texted", "quiet"])

    async def test_no_chats_skips_queries(self):
        from app.api.chats import _attach_last_activity

        await _attach_last_activity([], FakeDb())


if __name__ == "__main__":
    unittest.main()

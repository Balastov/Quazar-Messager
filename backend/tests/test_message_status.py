"""Unit tests for WebSocket message status helpers."""

from __future__ import annotations

import unittest

from app.ws.router import _STATUS_RANK, _collect_message_ids


class TestMessageStatusHelpers(unittest.TestCase):
    def test_collect_single_message_id(self):
        self.assertEqual(
            _collect_message_ids({"message_id": "abc", "status": "read"}),
            ["abc"],
        )

    def test_collect_message_ids_batch(self):
        self.assertEqual(
            _collect_message_ids({"message_ids": ["a", "b", "", 1], "status": "delivered"}),
            ["a", "b"],
        )

    def test_collect_empty(self):
        self.assertEqual(_collect_message_ids({"status": "read"}), [])

    def test_status_rank_monotonic(self):
        self.assertLess(_STATUS_RANK["sent"], _STATUS_RANK["delivered"])
        self.assertLess(_STATUS_RANK["delivered"], _STATUS_RANK["read"])


if __name__ == "__main__":
    unittest.main()

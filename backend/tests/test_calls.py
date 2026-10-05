"""Unit tests for call signaling helpers."""

from __future__ import annotations

import unittest

from app.ws.calls import _media_from_payload


class TestCallMedia(unittest.TestCase):
    def test_default_audio(self):
        self.assertEqual(_media_from_payload({}), "audio")

    def test_audio_video(self):
        self.assertEqual(
            _media_from_payload({"media": {"audio": True, "video": True}}),
            "audio_video",
        )

    def test_video_only(self):
        self.assertEqual(
            _media_from_payload({"media": {"audio": False, "video": True}}),
            "video",
        )


if __name__ == "__main__":
    unittest.main()

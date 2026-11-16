"""Альбом «IMG2:{images, text}»: подпись для упоминаний и обращений в поддержку."""

import json
import unittest

from app.core import notify, support

IMAGE = {"id": "0f8fad5b-d9cb-469f-a165-70867728950e", "key": "k", "mime": "image/jpeg", "w": 1, "h": 1, "size": 1}


class AlbumTest(unittest.TestCase):
    def test_mentions_come_from_the_caption_only(self):
        album = "IMG2:" + json.dumps({"images": [IMAGE], "text": "Смотри, @bob"})
        self.assertEqual(notify.chat_mention_text(album), "Смотри, @bob")
        self.assertEqual(notify.chat_mention_text("IMG2:{broken"), "")
        self.assertEqual(notify.chat_mention_text("IMG1:" + json.dumps(IMAGE)), "")

    def test_support_ticket_takes_images_and_caption(self):
        album = "IMG2:" + json.dumps({"images": [IMAGE, IMAGE | {"id": "x"}], "text": "Ошибка на экране"})
        images, text = support.album_ref(album)
        self.assertEqual((len(images), text), (2, "Ошибка на экране"))
        self.assertEqual(support.album_ref("IMG1:" + json.dumps(IMAGE)), ([IMAGE], ""))
        self.assertIsNone(support.album_ref("Просто текст"))
        self.assertIsNone(support.album_ref("IMG2:" + json.dumps({"images": [], "text": "x"})))

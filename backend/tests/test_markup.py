"""Разметка сообщений на сервере: push без значков, упоминания в коде не считаются."""

import unittest

from app.core.markup import plain_text, without_code
from app.core.notify import parse_mentions


class TestPlainText(unittest.TestCase):
    def test_strips_marks(self):
        cases = {
            "**важно**": "важно",
            "это _курсив_ и *тоже*": "это курсив и тоже",
            "~~старое~~ ~и это~": "старое и это",
            "вызови `run_all()` сейчас": "вызови run_all() сейчас",
            "**_вложенное_**": "вложенное",
            "> цитата\n> вторая": "цитата\nвторая",
            "```python\nprint(1)\n```": "print(1)",
            "смотри ```x = 1```": "смотри x = 1",
        }
        for src, want in cases.items():
            with self.subTest(src=src):
                self.assertEqual(plain_text(src), want)

    def test_keeps_plain_text(self):
        for src in ["snake_case_name", "2*3*4 = 24", "a ~ b", ">_<", "__init__", "https://x.ru/a_b_c", "просто текст"]:
            with self.subTest(src=src):
                self.assertEqual(plain_text(src), src)

    def test_code_keeps_marks(self):
        self.assertEqual(plain_text("`**не жирный**`"), "**не жирный**")


class TestMentionsInCode(unittest.TestCase):
    names = {"anna": "u1", "boris": "u2"}

    def test_code_is_not_a_mention(self):
        self.assertEqual(without_code("пиши `@anna` вот так"), "пиши  вот так")
        ids, everyone = parse_mentions("@boris пример: `@anna`\n```\n@все\n```", self.names)
        self.assertEqual(ids, {"u2"})
        self.assertFalse(everyone)

    def test_formatted_mention_counts(self):
        ids, _ = parse_mentions("**@anna** глянь", self.names)
        self.assertEqual(ids, {"u1"})


if __name__ == "__main__":
    unittest.main()

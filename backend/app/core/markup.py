"""Разметка сообщений — подмножество Markdown, рисует её клиент (web/src/chat/markdown.ts).

Серверу она нужна в двух местах: убрать значки из текста push-уведомлений и не считать
упоминанием «@имя» внутри кода.
"""

import re

_FENCE = re.compile(r"^```[^\n]*\n?(.*?)(?:\n?```[ \t]*$|\Z)", re.S | re.M)
_INLINE_FENCE = re.compile(r"```(.+?)```")
_CODE = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
_WRAPS = [
    re.compile(r"(?<![\w*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w*])"),
    re.compile(r"(?<![\w~])~~(?=\S)(.+?)(?<=\S)~~(?![\w~])"),
    re.compile(r"(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])"),
    re.compile(r"(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)"),
    re.compile(r"(?<![\w~])~(?=[^\s~])(.+?)(?<=[^\s~])~(?![\w~])"),
]
_QUOTE = re.compile(r"^>(?: |$)", re.M)


def without_code(text: str) -> str:
    """Текст без блоков и фрагментов кода."""
    if "`" not in text:
        return text
    text = _FENCE.sub("", text)
    text = _INLINE_FENCE.sub("", text)
    return _CODE.sub("", text)


def plain_text(text: str) -> str:
    """Текст без значков разметки — для push: «**важно**» → «важно»."""
    if not any(ch in text for ch in "*_~`>"):
        return text
    text = _FENCE.sub(lambda m: m.group(1), text)
    text = _INLINE_FENCE.sub(lambda m: m.group(1), text)
    codes: list[str] = []

    # Код — как есть: внутри него звёздочки не разметка.
    def keep(m: re.Match[str]) -> str:
        codes.append(m.group(2))
        return f"\x00{len(codes) - 1}\x00"

    text = _CODE.sub(keep, text)
    for wrap in _WRAPS:
        for _ in range(3):  # вложенная разметка: **_так_**
            text, n = wrap.subn(lambda m: m.group(1), text)
            if not n:
                break
    text = _QUOTE.sub("", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text).strip()

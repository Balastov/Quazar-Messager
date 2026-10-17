"""Геометрия карты офиса: сетка, размеры комнат, наложения, поиск свободного места.

Чистые функции — без БД. Координаты и размеры в клетках сетки.
"""

from __future__ import annotations

from typing import NamedTuple

GRID_W = 32
GRID_H = 20
MIN_SIZE = 2
MAX_W = 16
MAX_H = 12
MAX_FLOORS = 20

# Размер новой комнаты по типу (ширина, высота).
DEFAULT_ROOM_SIZE: dict[str, tuple[int, int]] = {
    "coworking": (8, 5),
    "meeting": (5, 4),
    "smoking": (3, 3),
    "kitchen": (5, 4),
    "custom": (4, 3),
}


class Rect(NamedTuple):
    x: int
    y: int
    w: int
    h: int


def default_size(room_kind: str | None) -> tuple[int, int]:
    return DEFAULT_ROOM_SIZE.get(room_kind or "", DEFAULT_ROOM_SIZE["custom"])


def overlaps(a: Rect, b: Rect) -> bool:
    """Касаться стенами можно, налезать — нет."""
    return a.x < b.x + b.w and b.x < a.x + a.w and a.y < b.y + b.h and b.y < a.y + a.h


def layout_error(rect: Rect) -> str | None:
    if rect.w < MIN_SIZE or rect.h < MIN_SIZE:
        return f"Комната не может быть меньше {MIN_SIZE}×{MIN_SIZE} клеток"
    if rect.w > MAX_W or rect.h > MAX_H:
        return f"Комната не может быть больше {MAX_W}×{MAX_H} клеток"
    if rect.x < 0 or rect.y < 0 or rect.x + rect.w > GRID_W or rect.y + rect.h > GRID_H:
        return "Комната выходит за границы этажа"
    return None


def first_overlap(rects: list[Rect]) -> tuple[int, int] | None:
    """Индексы первой пары налезающих комнат."""
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            if overlaps(rects[i], rects[j]):
                return i, j
    return None


def find_free_spot(occupied: list[Rect], w: int, h: int) -> Rect | None:
    """Первое свободное место слева направо, сверху вниз."""
    for y in range(0, GRID_H - h + 1):
        for x in range(0, GRID_W - w + 1):
            candidate = Rect(x, y, w, h)
            if not any(overlaps(candidate, other) for other in occupied):
                return candidate
    return None


def place(occupied: list[Rect], room_kind: str | None) -> Rect | None:
    """Место для новой комнаты: сначала обычного размера, если не влезает — поменьше."""
    w, h = default_size(room_kind)
    for size in ((w, h), (max(MIN_SIZE, w // 2), max(MIN_SIZE, h // 2)), (MIN_SIZE, MIN_SIZE)):
        spot = find_free_spot(occupied, *size)
        if spot:
            return spot
    return None

/**
 * Геометрия карты офиса на клиенте — те же правила, что на сервере (backend/app/core/office.py).
 * Координаты и размеры в клетках сетки.
 */
import type { RoomKind, StarChannel, StarFloor } from "../../api/stars";

export const GRID_W = 32;
export const GRID_H = 20;
export const MIN_SIZE = 2;
export const MAX_W = 16;
export const MAX_H = 12;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ROOM_ICON: Record<RoomKind, string> = {
  coworking: "💻",
  meeting: "🤝",
  smoking: "🚬",
  kitchen: "☕",
  custom: "🚪",
  lobby: "🛋",
};

export function rectOf(channel: StarChannel): Rect | null {
  const { map_x: x, map_y: y, map_w: w, map_h: h } = channel;
  if (x == null || y == null || w == null || h == null) return null;
  return { x, y, w, h };
}

/** Касаться стенами можно, налезать — нет. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function fits(rect: Rect, others: Rect[]): boolean {
  return !others.some((o) => overlaps(rect, o));
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Сдвиг на dx, dy клеток, не выходя за границы этажа. */
export function moveRect(start: Rect, dx: number, dy: number): Rect {
  return {
    ...start,
    x: clamp(start.x + dx, 0, GRID_W - start.w),
    y: clamp(start.y + dy, 0, GRID_H - start.h),
  };
}

/** Растягивание за правый нижний угол: в пределах размеров комнаты и этажа. */
export function resizeRect(start: Rect, dw: number, dh: number): Rect {
  return {
    ...start,
    w: clamp(start.w + dw, MIN_SIZE, Math.min(MAX_W, GRID_W - start.x)),
    h: clamp(start.h + dh, MIN_SIZE, Math.min(MAX_H, GRID_H - start.y)),
  };
}

export function sameRect(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export interface FloorGroup {
  floor: StarFloor;
  rooms: StarChannel[];
}

/** Комнаты по этажам в порядке этажей. Комната без этажа (или с удалённым) — на первом. */
export function groupByFloor(rooms: StarChannel[], floors: StarFloor[]): FloorGroup[] {
  const sorted = [...floors].sort((a, b) => a.position - b.position);
  const groups = sorted.map((floor) => ({ floor, rooms: [] as StarChannel[] }));
  for (const room of rooms) {
    const group = groups.find((g) => g.floor.id === room.floor_id) ?? groups[0];
    group?.rooms.push(room);
  }
  return groups;
}

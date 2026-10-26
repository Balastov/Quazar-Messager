import { describe, expect, it } from "vitest";
import type { StarChannel, StarFloor } from "../../../api/stars";
import { fits, GRID_H, GRID_W, groupByFloor, MAX_W, MIN_SIZE, moveRect, overlaps, resizeRect } from "../office";

describe("office geometry", () => {
  it("allows touching walls but not overlapping", () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 3 }, { x: 4, y: 0, w: 4, h: 3 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 3 }, { x: 3, y: 2, w: 4, h: 3 })).toBe(true);
    expect(fits({ x: 10, y: 10, w: 2, h: 2 }, [{ x: 0, y: 0, w: 4, h: 3 }])).toBe(true);
  });

  it("keeps a dragged room inside the floor", () => {
    const room = { x: 2, y: 2, w: 5, h: 4 };
    expect(moveRect(room, -10, -10)).toEqual({ x: 0, y: 0, w: 5, h: 4 });
    expect(moveRect(room, 100, 100)).toEqual({ x: GRID_W - 5, y: GRID_H - 4, w: 5, h: 4 });
  });

  it("limits resizing by room size and floor edge", () => {
    const room = { x: 28, y: 0, w: 3, h: 3 };
    expect(resizeRect(room, 10, 0).w).toBe(GRID_W - 28);
    expect(resizeRect(room, -10, -10)).toMatchObject({ w: MIN_SIZE, h: MIN_SIZE });
    expect(resizeRect({ x: 0, y: 0, w: 4, h: 4 }, 100, 0).w).toBe(MAX_W);
  });
});

describe("groupByFloor", () => {
  const floor = (id: string, position: number) => ({ id, name: id, position, version: 0 }) as StarFloor;
  const room = (id: string, floor_id: string | null) => ({ id, floor_id }) as StarChannel;

  it("groups rooms by floor in floor order, keeping empty floors", () => {
    const groups = groupByFloor(
      [room("a", "f2"), room("b", "f1"), room("c", "f2")],
      [floor("f2", 1), floor("f1", 0), floor("f3", 2)]
    );
    expect(groups.map((g) => [g.floor.id, g.rooms.map((r) => r.id)])).toEqual([
      ["f1", ["b"]],
      ["f2", ["a", "c"]],
      ["f3", []],
    ]);
  });

  it("puts rooms without a known floor on the first floor", () => {
    const groups = groupByFloor([room("a", null), room("b", "gone")], [floor("f1", 0), floor("f2", 1)]);
    expect(groups[0].rooms.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns nothing when there are no floors", () => {
    expect(groupByFloor([room("a", null)], [])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { squareCrop } from "../squareAvatar";

describe("squareCrop", () => {
  it("cuts the centre square and shrinks it to 512 px", () => {
    expect(squareCrop(4000, 3000)).toEqual({ sx: 500, sy: 0, side: 3000, out: 512 });
    expect(squareCrop(600, 900)).toEqual({ sx: 0, sy: 150, side: 600, out: 512 });
  });

  it("never enlarges small pictures", () => {
    expect(squareCrop(200, 300)).toEqual({ sx: 0, sy: 50, side: 200, out: 200 });
  });
});

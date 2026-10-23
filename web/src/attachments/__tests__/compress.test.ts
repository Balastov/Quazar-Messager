import { describe, expect, it } from "vitest";
import { keepOriginal, MAX_SIDE } from "../compress";
import { fitSize } from "../image";

describe("photo downscale", () => {
  it("fits phone photos into 2560 px on the long side", () => {
    expect(fitSize(4032, 3024, MAX_SIDE, MAX_SIDE)).toEqual({ width: 2560, height: 1920 });
    expect(fitSize(3024, 4032, MAX_SIDE, MAX_SIDE)).toEqual({ width: 1920, height: 2560 });
    expect(fitSize(1170, 2532, MAX_SIDE, MAX_SIDE)).toEqual({ width: 1170, height: 2532 });
  });

  it("always re-encodes JPEG so EXIF with location is dropped", () => {
    expect(keepOriginal("image/jpeg", false, 100_000, 300_000)).toBe(false);
  });

  it("keeps a small PNG/WebP when JPEG would not be smaller", () => {
    expect(keepOriginal("image/png", false, 80_000, 120_000)).toBe(true);
    expect(keepOriginal("image/webp", false, 80_000, 80_000)).toBe(true);
    expect(keepOriginal("image/png", false, 900_000, 200_000)).toBe(false);
    expect(keepOriginal("image/png", true, 80_000, 120_000)).toBe(false);
  });
});

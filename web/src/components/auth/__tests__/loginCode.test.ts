import { describe, expect, it } from "vitest";
import { normalizeCode, secondsUntil } from "../loginCode";

describe("login code", () => {
  it("keeps up to five digits from what was typed or pasted", () => {
    expect(normalizeCode("12 345")).toBe("12345");
    expect(normalizeCode("12-3456")).toBe("12345");
    expect(normalizeCode("код: 0 1")).toBe("01");
    expect(normalizeCode("١٢٣")).toBe("");
  });

  it("counts down to the resend time", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(secondsUntil("2026-11-17T12:00:41.200Z", now)).toBe(42);
    expect(secondsUntil("2026-11-17T11:59:00Z", now)).toBe(0);
    expect(secondsUntil("не дата", now)).toBe(0);
  });
});

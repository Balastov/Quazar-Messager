import { describe, expect, it } from "vitest";
import type { StarDetail } from "../../../api/stars";
import { activeSince, formatActive } from "../ActiveTime";

describe("formatActive", () => {
  it("minutes and seconds under an hour", () => {
    expect(formatActive(0)).toBe("0:00");
    expect(formatActive(65_400)).toBe("1:05");
    expect(formatActive(59 * 60_000 + 59_999)).toBe("59:59");
  });

  it("hours once it runs past an hour", () => {
    expect(formatActive(3_600_000)).toBe("1:00:00");
    expect(formatActive((26 * 3600 + 2 * 60 + 3) * 1000)).toBe("26:02:03");
  });

  it("clock skew never shows negative time", () => {
    expect(formatActive(-5000)).toBe("0:00");
  });
});

describe("activeSince", () => {
  const since = "2026-10-27T10:00:00+00:00";
  const detail = (voice: StarDetail["voice"]) => ({ voice, voice_since: { r1: since } }) as unknown as StarDetail;

  it("only while someone is inside", () => {
    expect(activeSince(detail({ r1: [{ user_id: "u1" }] } as unknown as StarDetail["voice"]), "r1")).toBe(since);
    expect(activeSince(detail({}), "r1")).toBeNull();
    expect(activeSince(detail({ r1: [] }), "r1")).toBeNull();
  });
});

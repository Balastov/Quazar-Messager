import { describe, expect, it } from "vitest";
import { presenceText, statusFromEvent, type PresenceStatus } from "../presence";

const now = new Date(2026, 9, 20, 15, 0); // 20 октября 2026, 15:00
const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
const base = (patch: Partial<PresenceStatus>): PresenceStatus => ({
  status: "offline",
  online: false,
  awaySince: null,
  lastSeen: null,
  manual: null,
  ...patch,
});
const offline = (msAgo: number) => base({ lastSeen: iso(msAgo) });

describe("presenceText", () => {
  it("says online and handles unknown status", () => {
    expect(presenceText(base({ status: "online", online: true }), now)).toBe("в сети");
    expect(presenceText(undefined, now)).toBeNull();
    expect(presenceText(base({}), now)).toBe("был(а) давно");
  });

  it("describes how long ago the person was here", () => {
    expect(presenceText(offline(20_000), now)).toBe("был(а) только что");
    expect(presenceText(offline(5 * 60_000), now)).toBe("был(а) 5 мин назад");
    expect(presenceText(offline(3 * 3600_000), now)).toBe("был(а) сегодня в 12:00");
    expect(presenceText(offline(20 * 3600_000), now)).toBe("был(а) вчера в 19:00");
    expect(presenceText(offline(5 * 86_400_000), now)).toMatch(/^был\(а\) 15 окт/);
  });

  it("says away and since when", () => {
    const away = (msAgo: number | null) =>
      base({ status: "away", online: true, awaySince: msAgo === null ? null : iso(msAgo) });
    expect(presenceText(away(null), now)).toBe("отошёл(ла)");
    expect(presenceText(away(30_000), now)).toBe("отошёл(ла) только что");
    expect(presenceText(away(12 * 60_000), now)).toBe("отошёл(ла) 12 мин назад");
  });

  it("shows the manual status over everything until it expires", () => {
    const in1h = new Date(now.getTime() + 3600_000).toISOString();
    const tomorrow = new Date(2026, 9, 21, 9, 30).toISOString();
    expect(presenceText(base({ status: "away", manual: { kind: "meeting", until: in1h } }), now)).toBe(
      "на встрече до 16:00"
    );
    expect(presenceText(base({ manual: { kind: "dnd", until: null } }), now)).toBe("не беспокоить");
    expect(presenceText(base({ status: "online", manual: { kind: "dnd", until: tomorrow } }), now)).toBe(
      "не беспокоить до 21 окт. 09:30"
    );
    // Истёк — снова обычный статус.
    expect(presenceText(base({ status: "online", manual: { kind: "meeting", until: iso(1000) } }), now)).toBe("в сети");
  });
});

describe("statusFromEvent", () => {
  it("reads the full status and understands the old server", () => {
    expect(
      statusFromEvent({ status: "away", online: true, away_since: "x", last_seen: null, manual: { kind: "dnd", until: null } })
    ).toEqual({ status: "away", online: true, awaySince: "x", lastSeen: null, manual: { kind: "dnd", until: null }, custom: null });
    expect(statusFromEvent({ online: true, last_seen: null })).toMatchObject({ status: "online", manual: null });
    expect(statusFromEvent({ online: false, last_seen: "y" })).toMatchObject({ status: "offline", lastSeen: "y" });
  });
});

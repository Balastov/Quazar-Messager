import { describe, expect, it } from "vitest";
import { presenceText } from "../presence";

const now = new Date(2026, 9, 20, 15, 0); // 20 октября 2026, 15:00
const ago = (ms: number) => ({ online: false, lastSeen: new Date(now.getTime() - ms).toISOString() });

describe("presenceText", () => {
  it("says online and handles unknown status", () => {
    expect(presenceText({ online: true, lastSeen: null }, now)).toBe("в сети");
    expect(presenceText(undefined, now)).toBeNull();
    expect(presenceText({ online: false, lastSeen: null }, now)).toBe("был(а) давно");
  });

  it("describes how long ago", () => {
    expect(presenceText(ago(20_000), now)).toBe("был(а) только что");
    expect(presenceText(ago(5 * 60_000), now)).toBe("был(а) 5 мин назад");
    expect(presenceText(ago(3 * 3600_000), now)).toMatch(/^был\(а\) сегодня в 12:00$/);
    expect(presenceText(ago(20 * 3600_000), now)).toMatch(/^был\(а\) вчера в 19:00$/);
    expect(presenceText(ago(5 * 86_400_000), now)).toMatch(/^был\(а\) 15 окт/);
    expect(presenceText({ online: false, lastSeen: new Date(2025, 0, 3).toISOString() }, now)).toMatch(/2025/);
  });
});

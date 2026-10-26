import { describe, expect, it } from "vitest";
import { encodeForward, parseForward, unwrapForward } from "../forward";
import { formatWhen, toLocalInput, whenPresets } from "../when";
import { timeLeft, ttlLabel } from "../ttl";
import {
  computeFingerprint,
  fingerprintMatches,
  fingerprintQr,
  parseFingerprintQr,
} from "../../crypto/fingerprint";

describe("forward", () => {
  it("wraps and unwraps any content", () => {
    const payload = encodeForward("Аня", 'IMG1:{"id":"x"}');
    expect(parseForward(payload)).toEqual({ from: "Аня", body: 'IMG1:{"id":"x"}' });
    expect(unwrapForward(payload)).toEqual({ payload: 'IMG1:{"id":"x"}', forwardedFrom: "Аня" });
    expect(unwrapForward("просто текст")).toEqual({ payload: "просто текст", forwardedFrom: null });
  });

  it("rejects broken and nested wrappers", () => {
    expect(parseForward("FWD1:{oops")).toBeNull();
    expect(parseForward('FWD1:{"from":"a","body":""}')).toBeNull();
    expect(parseForward(encodeForward("a", encodeForward("b", "x")))).toBeNull();
  });
});

describe("when", () => {
  it("offers tonight only while it is not too late", () => {
    const morning = new Date(2026, 9, 26, 10, 0);
    expect(whenPresets(morning).map((p) => p.label)).toContain("Сегодня в 20:00");
    const late = new Date(2026, 9, 26, 19, 45);
    expect(whenPresets(late).map((p) => p.label)).not.toContain("Сегодня в 20:00");
    const tomorrow = whenPresets(morning).find((p) => p.label === "Завтра в 9:00")!.at;
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([27, 9]);
  });

  it("formats dates for people", () => {
    const now = new Date(2026, 9, 26, 10, 0);
    expect(formatWhen(new Date(2026, 9, 26, 20, 0), now)).toBe("сегодня в 20:00");
    expect(formatWhen(new Date(2026, 9, 27, 9, 5), now)).toBe("завтра в 09:05");
    expect(toLocalInput(new Date(2026, 0, 2, 3, 4))).toBe("2026-01-02T03:04");
  });
});

describe("ttl", () => {
  it("labels and counts down", () => {
    expect(ttlLabel(86400)).toBe("1 день");
    expect(ttlLabel(null)).toBe("Выключено");
    const now = Date.parse("2026-10-26T10:00:00Z");
    expect(timeLeft("2026-10-26T10:30:00Z", now)).toBe("30 мин");
    expect(timeLeft("2026-10-26T15:00:00Z", now)).toBe("5 ч");
    expect(timeLeft("2026-10-26T10:00:20Z", now)).toBe("меньше минуты");
  });
});

describe("safety number", () => {
  const a = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  const b = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";

  it("is the same for both sides, 12 groups of 5 digits, without repeats", async () => {
    const f1 = await computeFingerprint(a, b);
    const f2 = await computeFingerprint(b, a);
    expect(f1).toBe(f2);
    expect(f1).toMatch(/^(\d{5} ){11}\d{5}$/);
    const digits = f1.replace(/ /g, "");
    // Прежний код повторял первые 28 цифр в конце.
    expect(digits.slice(32)).not.toBe(digits.slice(0, 28));
  });

  it("round-trips through the QR text and rejects foreign codes", async () => {
    const f = await computeFingerprint(a, b);
    const scanned = parseFingerprintQr(fingerprintQr(f));
    expect(scanned && fingerprintMatches(scanned, f)).toBe(true);
    expect(parseFingerprintQr("https://example.com")).toBeNull();
    expect(parseFingerprintQr("QZV1:123")).toBeNull();
  });
});

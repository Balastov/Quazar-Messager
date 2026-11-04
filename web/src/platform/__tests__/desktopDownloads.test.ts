import { describe, expect, it } from "vitest";
import { DESKTOP_INSTALLERS, detectDownloadOS, downloadPreference, parseDownloadPreference } from "../desktopDownloads";

describe("desktop download platform", () => {
  it.each([
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" }, "windows"],
    [{ userAgent: "reduced", userAgentData: { platform: "Windows", mobile: false } }, "windows"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel" }, "mac"],
    [{ userAgent: "reduced", userAgentData: { platform: "macOS", mobile: false } }, "mac"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 }, "other"],
    [{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18)", platform: "iPhone" }, "other"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l" }, "other"],
    [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" }, "other"],
    [{ userAgent: "unknown", userAgentData: { platform: "Windows", mobile: true } }, "other"],
  ] as const)("identifies supported desktop OS without mistaking phones or iPadOS for a Mac", (browser, expected) => {
    expect(detectDownloadOS(browser)).toBe(expected);
  });
  it("uses published anonymous installer links and keeps both Mac architectures available", () => {
    expect(DESKTOP_INSTALLERS.windows.url).toMatch(/\/releases\/download\/desktop-v[^/]+\/Quazar-[^/]+-win-x64\.exe$/);
    expect(DESKTOP_INSTALLERS.macArm.url).toMatch(/-mac-arm64\.dmg$/);
    expect(DESKTOP_INSTALLERS.macIntel.url).toMatch(/-mac-x64\.dmg$/);
  });
});

describe("desktop download prompt preference", () => {
  it("distinguishes postponing, declining and accepting", () => {
    const now = 1_000_000, day = 86_400_000;
    expect(downloadPreference("later", false, now)).toEqual({ never: false, nextAt: now + 7 * day });
    expect(downloadPreference("no", false, now)).toEqual({ never: false, nextAt: now + 30 * day });
    expect(downloadPreference("yes", false, now).never).toBe(true);
    expect(downloadPreference("later", true, now).never).toBe(true);
    expect(downloadPreference("no", true, now).never).toBe(true);
  });
  it("ignores corrupted or incompatible browser storage", () => {
    for (const value of [null, "invalid", "null", "[]", '{"never":"true","nextAt":0}', '{"never":true,"nextAt":-1}']) {
      expect(parseDownloadPreference(value)).toBeNull();
    }
    expect(parseDownloadPreference('{"never":true,"nextAt":123}')).toEqual({ never: true, nextAt: 123 });
  });
});

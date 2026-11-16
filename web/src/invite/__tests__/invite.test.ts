import { describe, expect, it, vi } from "vitest";
import { INVITE_TEXT, INVITE_URL, shareInvite, smsHref } from "../invite";

describe("invite text", () => {
  it("links to the main site", () => {
    expect(INVITE_URL).toBe("https://quazar-msg.ru");
    expect(INVITE_TEXT).toContain("https://quazar-msg.ru");
  });
});

describe("SMS link", () => {
  it("puts the encoded text into the body on Android and iPhone", () => {
    const text = "Привет & пока: https://quazar-msg.ru/?a=1";
    expect(smsHref(text, false)).toBe(`sms:?body=${encodeURIComponent(text)}`);
    expect(smsHref(text, true)).toBe(`sms:&body=${encodeURIComponent(text)}`);
    expect(decodeURIComponent(smsHref(text, false).slice("sms:?body=".length))).toBe(text);
  });
});

describe("sharing without SMS", () => {
  const env = (overrides: Partial<Parameters<typeof shareInvite>[1]>) => ({
    share: undefined, copy: undefined, prompt: vi.fn(), ...overrides,
  });

  it("uses the system share sheet when there is one", async () => {
    const e = env({ share: vi.fn().mockResolvedValue(undefined), copy: vi.fn() });
    expect(await shareInvite("текст", e)).toBe("shared");
    expect(e.share).toHaveBeenCalledWith({ title: "Quazar", text: "текст" });
    expect(e.copy).not.toHaveBeenCalled();
  });

  it("does nothing more when the person closes the share sheet", async () => {
    const e = env({ share: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "AbortError" })), copy: vi.fn() });
    expect(await shareInvite("текст", e)).toBe("cancelled");
    expect(e.copy).not.toHaveBeenCalled();
  });

  it("copies the text when sharing is missing or fails", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    expect(await shareInvite("текст", env({ copy }))).toBe("copied");
    expect(await shareInvite("текст", env({ share: vi.fn().mockRejectedValue(new Error("no")), copy }))).toBe("copied");
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it("shows the text for manual copying when the clipboard is blocked", async () => {
    const e = env({ copy: vi.fn().mockRejectedValue(new Error("denied")) });
    expect(await shareInvite("текст", e)).toBe("manual");
    expect(e.prompt).toHaveBeenCalledWith(expect.any(String), "текст");
  });
});

import { describe, expect, it } from "vitest";
import {
  canSearchUsers,
  formatPhoneInput,
  isForeignPhoneInput,
  phoneSearchDigits,
  toE164,
  verifiesByTelegram,
  extractRuLocalDigits,
  formatPhoneDisplay,
  formatRuPhoneMask,
  looksLikePhoneQuery,
  toE164Ru,
} from "../phone";

describe("Russian phone mask", () => {
  it("formats while typing", () => {
    expect(formatRuPhoneMask("999")).toBe("+7 (999)");
    expect(formatRuPhoneMask("999123")).toBe("+7 (999) 123");
    expect(formatRuPhoneMask("9991234567")).toBe("+7 (999) 123-45-67");
  });

  it("strips 8 / 7 prefixes", () => {
    expect(extractRuLocalDigits("89991234567")).toBe("9991234567");
    expect(extractRuLocalDigits("+7 999 123-45-67")).toBe("9991234567");
  });

  it("builds E.164", () => {
    expect(toE164Ru("+7 (999) 123-45-67")).toBe("+79991234567");
    expect(toE164Ru("+7 (999) 123")).toBeNull();
  });

  it("formats display and detects phone queries", () => {
    expect(formatPhoneDisplay("+79991234567")).toBe("+7 (999) 123-45-67");
    expect(looksLikePhoneQuery("999")).toBe(true);
    expect(looksLikePhoneQuery("ab")).toBe(false);
    expect(canSearchUsers("al")).toBe(true);
    expect(canSearchUsers("99")).toBe(false);
    expect(canSearchUsers("999")).toBe(true);
  });
});

describe("international phones", () => {
  it("keeps the Russian mask and lets the 7 be erased to type another country", () => {
    expect(formatPhoneInput("89991234567")).toBe("+7 (999) 123-45-67");
    expect(formatPhoneInput("+")).toBe("+");
    expect(formatPhoneInput("+44")).toBe("+44");
    expect(formatPhoneInput("+447911123456")).toBe("+44 7911 123456");
    expect(formatPhoneInput("00447911123456")).toBe("+44 7911 123456");
    expect(formatPhoneInput("+1 2025550143999999")).not.toMatch(/\d{16}/);
  });

  it("builds E.164 only for complete valid numbers", () => {
    expect(toE164("+44 7911 123456")).toBe("+447911123456");
    expect(toE164("+44 7911")).toBeNull();
    expect(toE164("+1 (202) 555-0143")).toBe("+12025550143");
    expect(toE164("+7 (999) 123-45-67")).toBe("+79991234567");
    expect(toE164("8 999 123 45 67")).toBe("+79991234567");
    expect(toE164("07911123456")).toBeNull();
    expect(toE164("+77011234567")).toBe("+77011234567");
  });

  it("chooses Telegram for non +7 numbers", () => {
    expect(isForeignPhoneInput("+7 (999)")).toBe(false);
    expect(isForeignPhoneInput("+380")).toBe(true);
    expect(verifiesByTelegram("+447911123456")).toBe(true);
    expect(verifiesByTelegram("+77011234567")).toBe(false);
  });

  it("formats stored numbers and searches by every digit of a foreign number", () => {
    expect(formatPhoneDisplay("+447911123456")).toBe("+44 7911 123456");
    expect(formatPhoneDisplay("+79991234567")).toBe("+7 (999) 123-45-67");
    expect(phoneSearchDigits("+44 7911")).toBe("447911");
    expect(phoneSearchDigits("+7 999")).toBe("999");
    expect(canSearchUsers("+44")).toBe(false);
    expect(canSearchUsers("+447")).toBe(true);
  });
});

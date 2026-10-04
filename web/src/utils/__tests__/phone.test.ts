import { describe, expect, it } from "vitest";
import {
  canSearchUsers,
  extractRuLocalDigits,
  formatRuPhoneDisplay,
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
    expect(formatRuPhoneDisplay("+79991234567")).toBe("+7 (999) 123-45-67");
    expect(looksLikePhoneQuery("999")).toBe(true);
    expect(looksLikePhoneQuery("ab")).toBe(false);
    expect(canSearchUsers("al")).toBe(true);
    expect(canSearchUsers("99")).toBe(false);
    expect(canSearchUsers("999")).toBe(true);
  });
});

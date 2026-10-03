import { describe, expect, it } from "vitest";
import { extractRuLocalDigits, formatRuPhoneMask, toE164Ru } from "../phone";

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
});

import { describe, expect, it } from "vitest";
import type { StarMember } from "../../../api/stars";
import { isPartialPhone, matchesMember, normalizeSearch, phoneQuery } from "../memberSearch";

const member = (user: Partial<StarMember["user"]>): StarMember => ({
  user: { id: "u1", username: "fedor_k", avatar_url: null, ...user },
  role: "member",
  joined_at: "2026-11-01T00:00:00Z",
});

describe("member search by name", () => {
  const fedor = member({
    username: "fedor_k", display_name: "Капитан", account_display_name: "Фёдор Ёлкин", pseudonym: "Капитан",
  });

  it("finds by nickname, with or without @, ignoring case", () => {
    expect(matchesMember(fedor, "FEDOR")).toBe(true);
    expect(matchesMember(fedor, "@fedor_k")).toBe(true);
  });

  it("finds by first or last name in any order, treating ё as е", () => {
    expect(matchesMember(fedor, "федор")).toBe(true);
    expect(matchesMember(fedor, "елкин фёдор")).toBe(true);
    expect(matchesMember(fedor, "Ёлк")).toBe(true);
  });

  it("finds by the pseudonym in this Star", () => {
    expect(matchesMember(fedor, "капит")).toBe(true);
  });

  it("needs every word to match", () => {
    expect(matchesMember(fedor, "фёдор иванов")).toBe(false);
    expect(matchesMember(fedor, "анна")).toBe(false);
  });

  it("shows everyone for an empty query", () => {
    expect(matchesMember(fedor, "   ")).toBe(true);
  });

  it("normalizes text", () => {
    expect(normalizeSearch("  ЁЖИК ")).toBe("ежик");
  });
});

describe("member search by phone", () => {
  it("checks only a full number", () => {
    expect(phoneQuery("+7 (999) 123-45-67")).toBe("+79991234567");
    expect(phoneQuery("89991234567")).toBe("+79991234567");
    expect(phoneQuery("+7 999 123")).toBeNull();
  });

  it("does not treat nicknames with digits as phones", () => {
    expect(phoneQuery("player9991234567")).toBeNull();
    expect(isPartialPhone("player123")).toBe(false);
  });

  it("hints when only part of a number is typed", () => {
    expect(isPartialPhone("+7 999 12")).toBe(true);
    expect(isPartialPhone("12")).toBe(false);
    expect(isPartialPhone("+7 (999) 123-45-67")).toBe(false);
  });
});

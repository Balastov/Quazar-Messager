import { expect, it } from "vitest";
import { listTimestamp } from "../listTimestamp";
const now = new Date(2026, 10, 7, 20, 30);
it("shows only the time for today's calendar date", () => {
  expect(listTimestamp(new Date(2026, 10, 7, 1, 5).toISOString(), now)).toBe("01:05");
});
it("shows yesterday and time even when more than 24 hours have elapsed", () => {
  expect(listTimestamp(new Date(2026, 10, 6, 0, 3).toISOString(), now)).toBe("вчера 00:03");
});
it("shows a date for older messages", () => {
  expect(listTimestamp(new Date(2026, 10, 5, 23, 59).toISOString(), now)).toBe("05.11.2026");
});
it("handles midnight, month and year boundaries as calendar days", () => {
  expect(listTimestamp(new Date(2025, 11, 31, 23, 59).toISOString(), new Date(2026, 0, 1, 0, 1))).toBe("вчера 23:59");
  expect(listTimestamp(new Date(2024, 1, 29, 10, 0).toISOString(), new Date(2024, 2, 1, 1, 0))).toBe("вчера 10:00");
});
it("does not display invalid timestamps", () => expect(listTimestamp("invalid", now)).toBe(""));

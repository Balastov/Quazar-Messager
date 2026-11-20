import { expect, it } from "vitest";
import { messageTime, messageTimeTitle } from "../messageTime";

const now = new Date(2026, 10, 20, 12, 0);
const at = (...args: [number, number, number, number, number]) => new Date(...args).toISOString();

it("shows only the time when no date is asked for", () => {
  expect(messageTime(at(2026, 10, 20, 9, 5), false, now)).toBe("09:05");
});
it("adds day and month for this year's messages, including today", () => {
  expect(messageTime(at(2026, 10, 20, 9, 5), true, now)).toBe("20.11 09:05");
  expect(messageTime(at(2026, 0, 3, 23, 59), true, now)).toBe("03.01 23:59");
});
it("adds the year for messages from previous years", () => {
  expect(messageTime(at(2025, 11, 31, 0, 0), true, now)).toBe("31.12.2025 00:00");
});
it("gives the full date in the hover title", () => {
  expect(messageTimeTitle(at(2026, 10, 20, 14, 5))).toBe("20 ноября 2026 г., 14:05");
});
it("does not display invalid timestamps", () => {
  expect(messageTime("invalid", true, now)).toBe("");
  expect(messageTimeTitle("invalid")).toBe("");
});

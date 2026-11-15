import { expect, it } from "vitest";
import { avatarInitials, displayName } from "../profile";

it("takes the first letters of the first and last name", () => {
  expect(avatarInitials("Анна Смирнова")).toBe("АС");
  expect(avatarInitials("  иван   петров  ")).toBe("ИП");
  expect(avatarInitials("Анна Мария Смирнова")).toBe("АМ");
});

it("takes the first two letters of a single word", () => {
  expect(avatarInitials("Анна")).toBe("АН");
  expect(avatarInitials("Ёж")).toBe("ЁЖ");
  expect(avatarInitials("Я")).toBe("Я");
});

it("falls back to the first two letters of the nickname when no name is filled", () => {
  expect(avatarInitials(displayName({ username: "device_test", display_name: "device_test" }))).toBe("DE");
  expect(avatarInitials(displayName({ username: "alice", display_name: "" }))).toBe("AL");
  expect(avatarInitials(displayName({ username: "alice", display_name: "Алиса Иванова" }))).toBe("АИ");
});

it("skips words that start with punctuation and keeps an emoji as is", () => {
  expect(avatarInitials("Пётр (гость)")).toBe("ПЁ");
  expect(avatarInitials("👨‍👩‍👧‍👦 Семья")).toBe("👨‍👩‍👧‍👦");
  expect(avatarInitials("🇨🇳 Китай")).toBe("🇨🇳");
  expect(avatarInitials("")).toBe("?");
  expect(avatarInitials("--")).toBe("?");
});

import { describe, expect, it } from "vitest";
import { compareNames, compareUsers, displayName, usernameProblem } from "../profile";
import { compareNames as mobileCompareNames, compareUsers as mobileCompareUsers } from "../../../../mobile/src/utils/profile";

describe("usernameProblem", () => {
  it("принимает латиницу, цифры, _ и .", () => {
    expect(usernameProblem("Alex_99.dev")).toBeNull();
    expect(usernameProblem("@neo")).toBeNull();
  });

  it("отклоняет то же, что и сервер", () => {
    for (const bad of ["Алекс", "al", "9lives", "alex.", "al..ex", "x".repeat(33), "All", "quazar"]) {
      expect(usernameProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("displayName", () => {
  it("имя с сервера, иначе никнейм", () => {
    expect(displayName({ username: "alex", display_name: "Алексей Иванов" })).toBe("Алексей Иванов");
    expect(displayName({ username: "alex" })).toBe("alex");
    expect(displayName(undefined) ?? "Участник").toBe("Участник");
  });
});

for (const [platform, names, users] of [
  ["web", compareNames, compareUsers],
  ["mobile", mobileCompareNames, mobileCompareUsers],
] as const) {
  describe(`alphabetical user order (${platform})`, () => {
    it("puts Cyrillic before Latin and all other starting characters last", () => {
      const sorted = ["🙂 Анна", "123", "Zoë", "Борис", "alice", "#Вера", "Яна", "Анна", "Bob", "山田"]
        .sort(names);
      expect(sorted.slice(0, 6)).toEqual(["Анна", "Борис", "Яна", "alice", "Bob", "Zoë"]);
      expect(sorted.slice(6)).toEqual(expect.arrayContaining(["🙂 Анна", "123", "#Вера", "山田"]));
    });

    it("sorts by display name and falls back to a nickname for empty or missing names", () => {
      const sorted = [
        { username: "aaron", display_name: "Яна" },
        { username: "zoya", display_name: "  Анна  " },
        { username: "alice", display_name: " \t" },
        { username: "bob", display_name: null },
        { username: "charlie" },
      ].sort(users);
      expect(sorted.map((u) => u.username)).toEqual(["zoya", "aaron", "alice", "bob", "charlie"]);
    });

    it("ignores case, handles Ё, and recognizes extended Cyrillic and accented Latin", () => {
      expect(names("АННА", "анна")).toBe(0);
      expect(names("  Alice ", "alice")).toBe(0);
      expect(names("Елена", "Жанна")).toBeLessThan(0);
      expect(names("Ёлка", "Жанна")).toBeLessThan(0);
      expect(names("Єва", "Alice")).toBeLessThan(0);
      expect(names("Émile", "123")).toBeLessThan(0);
      expect(names("E\u0301mile", "Émile")).toBe(0);
    });

    it("breaks equal display names by nickname and gives numbers a natural order", () => {
      expect(users({ username: "anna", display_name: "Алекс" }, { username: "zoya", display_name: "Алекс" }))
        .toBeLessThan(0);
      expect(names("Анна 2", "Анна 10")).toBeLessThan(0);
    });
  });
}

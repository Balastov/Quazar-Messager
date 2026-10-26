import { describe, expect, it } from "vitest";
import { displayName, usernameProblem } from "../profile";

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

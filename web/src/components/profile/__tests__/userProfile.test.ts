import { describe, expect, it } from "vitest";
import { useProfileStore } from "../../../store/profile";
import { joinedDate } from "../UserProfileDialog";

describe("profile card", () => {
  it("opens for one person at a time and closes", () => {
    useProfileStore.getState().open({ userId: "u1", starId: "star", hint: { username: "fedor" } });
    useProfileStore.getState().open({ userId: "u2" });
    expect(useProfileStore.getState().target).toEqual({ userId: "u2" });
    useProfileStore.getState().close();
    expect(useProfileStore.getState().target).toBeNull();
  });

  it("writes the sign-up date in words", () => {
    expect(joinedDate("2026-11-05T12:00:00Z")).toBe("5 ноября 2026 г.");
    expect(joinedDate("не дата")).toBe("");
  });
});

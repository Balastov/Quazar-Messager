import { describe, expect, it } from "vitest";
import { applyReaction, groupReactions, myReaction, toggledReaction } from "../reactions";
import { createTypingThrottle, typingLabel } from "../typing";

describe("reactions", () => {
  const list = [
    { user_id: "a", emoji: "🔥" },
    { user_id: "b", emoji: "👍" },
    { user_id: "c", emoji: "🔥" },
  ];

  it("groups by emoji in order of the first one and marks mine", () => {
    expect(groupReactions(list, "c")).toEqual([
      { emoji: "🔥", count: 2, mine: true, userIds: ["a", "c"] },
      { emoji: "👍", count: 1, mine: false, userIds: ["b"] },
    ]);
    expect(groupReactions(undefined, "a")).toEqual([]);
  });

  it("finds my reaction", () => {
    expect(myReaction(list, "b")).toBe("👍");
    expect(myReaction(list, "z")).toBeNull();
  });

  it("toggles: same emoji removes, another replaces", () => {
    expect(toggledReaction("👍", "👍")).toBeNull();
    expect(toggledReaction("👍", "🔥")).toBe("🔥");
    expect(toggledReaction(null, "🔥")).toBe("🔥");
  });

  it("keeps one reaction per person", () => {
    const next = applyReaction(list, "a", { user_id: "a", emoji: "😂" });
    expect(next.filter((r) => r.user_id === "a")).toEqual([{ user_id: "a", emoji: "😂" }]);
    expect(applyReaction(next, "a", null).some((r) => r.user_id === "a")).toBe(false);
    expect(applyReaction(undefined, "a", null)).toEqual([]);
  });
});

describe("typing", () => {
  it("throttles per target and resets after sending", () => {
    let t = 0;
    const throttle = createTypingThrottle(3000, () => t);
    expect(throttle.shouldSend("chat:1")).toBe(true);
    t = 1000;
    expect(throttle.shouldSend("chat:1")).toBe(false);
    expect(throttle.shouldSend("chat:2")).toBe(true);
    throttle.reset("chat:1");
    expect(throttle.shouldSend("chat:1")).toBe(true);
    t = 4500;
    expect(throttle.shouldSend("chat:1")).toBe(true);
  });

  it("names who is typing", () => {
    expect(typingLabel([])).toBeNull();
    expect(typingLabel(["Аня"])).toBe("Аня печатает…");
    expect(typingLabel(["Аня", "Боря"])).toBe("Аня и Боря печатают…");
    expect(typingLabel(["Аня", "Боря", "Вика"])).toBe("Аня и ещё 2 печатают…");
  });
});

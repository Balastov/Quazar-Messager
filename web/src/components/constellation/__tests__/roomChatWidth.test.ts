import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_MAX, CHAT_MIN, clampChatWidth, maxChatWidth, savedChatWidth, saveChatWidth } from "../roomChatWidth";

describe("room chat width", () => {
  it("keeps the chat between its limits and leaves the room at least 320px", () => {
    expect(clampChatWidth(100, 1400)).toBe(CHAT_MIN);
    expect(clampChatWidth(500.4, 1400)).toBe(500);
    expect(clampChatWidth(2000, 2400)).toBe(CHAT_MAX);
    expect(clampChatWidth(900, 1000)).toBe(680);
    expect(maxChatWidth(1000)).toBe(680);
  });

  it("never goes below the minimum, even in a narrow window", () => {
    expect(clampChatWidth(500, 500)).toBe(CHAT_MIN);
  });

  describe("storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    afterEach(() => store.clear());

    it("remembers the width and forgets it on reset", () => {
      expect(savedChatWidth()).toBeNull();
      saveChatWidth(512.6);
      expect(savedChatWidth()).toBe(513);
      saveChatWidth(null);
      expect(savedChatWidth()).toBeNull();
    });

    it("ignores broken or out-of-range values", () => {
      store.set("quazar-room-chat-width", "abc");
      expect(savedChatWidth()).toBeNull();
      store.set("quazar-room-chat-width", "50");
      expect(savedChatWidth()).toBeNull();
    });
  });
});

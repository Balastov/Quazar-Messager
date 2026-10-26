import { describe, expect, it } from "vitest";
import { hotkey, isTyping, keyLabel } from "../../../voice/keys";
import { onlyEmoji } from "../StarText";
import { plural } from "../PollCard";
import { auditText } from "../audit";
import type { AuditEntry } from "../../../api/stars";

const key = (code: string, mods: Partial<KeyboardEventInit> = {}) =>
  ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe("voice keys", () => {
  it("names keys for people", () => {
    expect(keyLabel("Backquote")).toBe("Ё / `");
    expect(keyLabel("KeyV")).toBe("V");
    expect(keyLabel("ShiftLeft")).toBe("Shift Left");
  });

  it("recognises hotkeys only with Ctrl+Shift", () => {
    expect(hotkey(key("KeyM", { ctrlKey: true, shiftKey: true }))).toBe("mic");
    expect(hotkey(key("KeyD", { ctrlKey: true, shiftKey: true }))).toBe("deafen");
    expect(hotkey(key("KeyM", { ctrlKey: true }))).toBeNull();
    expect(hotkey(key("KeyM", { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it("leaves typing alone", () => {
    expect(isTyping({ tagName: "INPUT", isContentEditable: false } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: "DIV", isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });
});

describe("star emoji", () => {
  const emoji = { pog: "/p.png", gg: "/g.png" };
  it("shows big only for 1–3 known emoji and nothing else", () => {
    expect(onlyEmoji(":pog:", emoji)).toBe(true);
    expect(onlyEmoji(":pog: :gg:", emoji)).toBe(true);
    expect(onlyEmoji(":pog: привет", emoji)).toBe(false);
    expect(onlyEmoji(":unknown:", emoji)).toBe(false);
    expect(onlyEmoji(":pog::pog::pog::pog:", emoji)).toBe(false);
  });
});

describe("plural", () => {
  it("picks the Russian form", () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, "голос", "голоса", "голосов"))).toEqual([
      "голос",
      "голоса",
      "голосов",
      "голосов",
      "голос",
      "голоса",
      "голосов",
    ]);
  });
});

describe("audit", () => {
  const entry = (action: string, details: Record<string, unknown> = {}): AuditEntry => ({
    id: "1",
    actor: { id: "a", username: "Аня", avatar_url: null },
    target: { id: "b", username: "Боря", avatar_url: null },
    target_id: "b",
    action,
    details,
    created_at: "2026-10-26T10:00:00Z",
  });

  it("writes readable lines", () => {
    expect(auditText(entry("timeout", { minutes: 60 }))).toBe("Аня дал(а) Боря тайм-аут на 1 час");
    expect(auditText(entry("role", { before: "member", after: "moderator" }))).toBe(
      "Аня сменил(а) роль Боря: Участник → Модератор"
    );
    expect(auditText(entry("tag", { op: "give", name: "Танк" }))).toBe("Аня выдал(а) Боря роль «Танк»");
  });
});

import { describe, expect, it } from "vitest";
import { encodeWithPreview, firstLink, unwrapPreview } from "../linkPreview";
import { encodeForward, unwrapForward } from "../forward";
import { matches, queryWords, snippet } from "../search";
import { activeCustom, statusFromEvent } from "../../utils/presence";

const preview = { url: "https://example.com/a", title: "Пример", description: "", site: "example.com", image: null };

describe("link previews", () => {
  it("wraps text with a preview and survives forwarding", () => {
    const wrapped = encodeWithPreview("смотри https://example.com/a", preview);
    expect(unwrapPreview(wrapped)).toEqual({ payload: "смотри https://example.com/a", preview });
    const fwd = unwrapForward(encodeForward("Аня", wrapped));
    expect([fwd.payload, fwd.forwardedFrom, fwd.preview?.title]).toEqual(["смотри https://example.com/a", "Аня", "Пример"]);
  });

  it("drops unsafe previews", () => {
    const bad = encodeWithPreview("x", { ...preview, url: "javascript:alert(1)" });
    expect(unwrapPreview(bad).preview).toBeNull();
    const svg = encodeWithPreview("x", { ...preview, image: "data:image/svg+xml;base64,AAA" });
    expect(unwrapPreview(svg).preview?.image).toBeNull();
    expect(unwrapPreview("LNK1:{oops").payload).toBe("LNK1:{oops");
  });

  it("finds the first link", () => {
    expect(firstLink("см. example.com/x и https://b.ru")).toBe("https://example.com/x");
    expect(firstLink("без ссылок")).toBeNull();
  });
});

describe("search", () => {
  it("matches all words ignoring case and ё", () => {
    const words = queryWords("ЕЛКА зеленая");
    expect(matches("Ёлка зелёная стоит", words)).toBe(true);
    expect(matches("ёлка", words)).toBe(false);
    const parts = snippet("В лесу родилась ёлочка, в лесу она росла", queryWords("лес"));
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["лес", "лес"]);
  });
});

describe("custom status", () => {
  it("expires by itself", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const s = (until: string | null) =>
      statusFromEvent({ online: true, last_seen: null, custom: { icon: "plane", text: "в отпуске", until } });
    expect(activeCustom(s("2026-10-27T13:00:00Z"), now)?.text).toBe("в отпуске");
    expect(activeCustom(s("2026-10-27T11:00:00Z"), now)).toBeNull();
    expect(activeCustom(s(null), now)?.icon).toBe("plane");
  });
});

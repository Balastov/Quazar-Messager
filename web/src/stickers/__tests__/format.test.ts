import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ http: { get: vi.fn(), defaults: { baseURL: "/api" } } }));

const { encodeSticker, parseSticker } = await import("../format");
const { messagePreview, useStickersStore } = await import("../../store/stickers");
const { stickerFileUrl } = await import("../../api/stickers");

describe("sticker messages", () => {
  it("round-trips pack and id", () => {
    const payload = encodeSticker("noto", "2764_fe0f_200d_1f525");
    expect(payload).toBe("STK1:noto/2764_fe0f_200d_1f525");
    expect(parseSticker(payload)).toEqual({ pack: "noto", id: "2764_fe0f_200d_1f525" });
  });

  it("does not mistake ordinary text for a sticker", () => {
    for (const text of ["STK1:", "STK1:noto", "смотри STK1:noto/1f602", "STK1:noto/1f602 ", "STK1:../x/y", "STK1:Noto/1f602"]) {
      expect(parseSticker(text), text).toBeNull();
    }
  });

  it("previews stickers with their emoji", () => {
    useStickersStore.setState({ byKey: { "noto/1f602": { id: "1f602", emoji: "😂", url: "/stickers/files/noto/1f602.json?v=1" } } });
    expect(messagePreview("STK1:noto/1f602")).toBe("Стикер 😂");
    expect(messagePreview("STK1:gone/abc")).toBe("Стикер");
    expect(messagePreview("привет")).toBe("привет");
  });

  it("builds file urls under the web API prefix", () => {
    expect(stickerFileUrl({ id: "1f602", emoji: "😂", url: "/stickers/files/noto/1f602.json?v=1" })).toBe(
      "/api/stickers/files/noto/1f602.json?v=1"
    );
  });
});

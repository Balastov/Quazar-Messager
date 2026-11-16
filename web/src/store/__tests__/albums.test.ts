import "fake-indexeddb/auto";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { beforeEach, expect, it, vi } from "vitest";
import type { Chat } from "../../api/types";
import { decryptMessage } from "../../crypto/message";
import { decryptFile, encodeAlbum, encryptFile, parseAlbum, type ImageRef } from "../../attachments/image";
import { parseForward } from "../../chat/forward";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
});

const mine = nacl.box.keyPair();
const peer = nacl.box.keyPair();
vi.mock("../../crypto/keys", async (original) => ({
  ...await original<typeof import("../../crypto/keys")>(),
  loadKeys: async () => ({ publicKey: encodeBase64(mine.publicKey), seed: mine.secretKey, privateKey: null }),
  loadDecryptionKeys: async () => [{ seed: mine.secretKey }],
}));
vi.mock("../../crypto/trust", async (original) => ({
  ...await original<typeof import("../../crypto/trust")>(),
  resolvePeerTrust: vi.fn(),
}));
vi.mock("../../api/messages", async (original) => ({
  ...await original<typeof import("../../api/messages")>(),
  messagesApi: { ...(await original<typeof import("../../api/messages")>()).messagesApi, send: vi.fn() },
}));
vi.mock("../../api/attachments", () => ({ attachmentsApi: { upload: vi.fn(), download: vi.fn() } }));
vi.mock("../../attachments/cache", async (original) => ({
  ...await original<typeof import("../../attachments/cache")>(), seedImageUrl: vi.fn(), seedVoiceUrl: vi.fn(),
}));
vi.mock("../../attachments/compress", async (original) => ({
  ...await original<typeof import("../../attachments/compress")>(),
  prepareImage: vi.fn(async (bytes: Uint8Array) => ({ bytes, mime: "image/png", w: 40, h: 30 })),
}));
vi.mock("../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn() } }));

const { useE2EStore } = await import("../e2e");
const { useChatStore } = await import("../chat");
const { useAuthStore } = await import("../auth");
const { messagesApi } = await import("../../api/messages");
const { attachmentsApi } = await import("../../api/attachments");
const { resolvePeerTrust } = await import("../../crypto/trust");

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3];
const png = (name: string, tail: number) => new File([new Uint8Array([...PNG, tail])], name, { type: "image/png" });
const uploads = new Map<string, Uint8Array>();
const lastByte = (bytes: Uint8Array | null) => (bytes ? bytes[bytes.length - 1] : null);

beforeEach(() => {
  vi.clearAllMocks();
  uploads.clear();
  useAuthStore.setState({ user: { id: "me", username: "я" } as never });
  useE2EStore.setState({ status: "ready" });
  const members = [{ user: { id: "me", username: "я" }, role: "member" }, { user: { id: "peer", username: "собеседник" }, role: "member" }];
  useChatStore.setState({
    chats: [{ id: "direct-1", type: "direct", members }, { id: "group-1", type: "group", name: "Группа", members }] as Chat[],
    messages: {}, activeChatId: null, loadingMessages: false,
  });
  vi.mocked(resolvePeerTrust).mockResolvedValue({ status: "ok", publicKey: encodeBase64(peer.publicKey), fingerprint: null, verified: false });
  let n = 0;
  vi.mocked(attachmentsApi.upload).mockImplementation(async (_chat, blob) => {
    const id = `00000000-0000-4000-8000-00000000000${++n}`;
    uploads.set(id, blob);
    return { id, size: blob.length };
  });
  vi.mocked(attachmentsApi.download).mockImplementation(async (_chat, id) => uploads.get(id) as Uint8Array<ArrayBuffer>);
  vi.mocked(messagesApi.send).mockResolvedValue({ id: "m1" } as never);
});

it("sends several pictures and the caption as one encrypted message with every attachment", async () => {
  const done: number[] = [];
  await useChatStore.getState().sendImages("direct-1", [png("a.png", 1), png("b.png", 2)], "Подпись", "reply-1", (n) => done.push(n));
  expect(messagesApi.send).toHaveBeenCalledOnce();
  const [chatId, payload, ids, replyId] = vi.mocked(messagesApi.send).mock.calls[0];
  expect([chatId, replyId, done]).toEqual(["direct-1", "reply-1", [1, 2]]);
  expect(ids).toEqual([...uploads.keys()]);
  expect(payload.startsWith("ENC2:")).toBe(true);
  const album = parseAlbum((await decryptMessage(payload, { seed: peer.secretKey })) ?? "");
  expect(album?.text).toBe("Подпись");
  expect(album?.images.map((i) => i.id)).toEqual(ids);
  // Картинки зашифрованы своими ключами; собеседник их открывает.
  expect(lastByte(decryptFile(uploads.get(album!.images[1].id)!, album!.images[1].key))).toBe(2);
});

it("refuses more than six pictures and names the picture that is not an image", async () => {
  const seven = Array.from({ length: 7 }, (_, i) => png(`${i}.png`, i));
  await expect(useChatStore.getState().sendImages("group-1", seven, "")).rejects.toThrow("не больше 6");
  const bad = new File([new Uint8Array(20)], "notes.txt", { type: "image/png" });
  await expect(useChatStore.getState().sendImages("group-1", [png("a.png", 1), bad], "")).rejects.toThrow("«notes.txt»");
  expect(messagesApi.send).not.toHaveBeenCalled();
});

it("forwards an album by re-uploading every picture to the target chat", async () => {
  const refs: ImageRef[] = [1, 2].map((tail) => {
    const { blob, key } = encryptFile(new Uint8Array([...PNG, tail]));
    const id = `00000000-0000-4000-8000-00000000009${tail}`;
    uploads.set(id, blob);
    return { id, key, mime: "image/png", w: 40, h: 30, size: PNG.length + 1 };
  });
  const message = { id: "src", chat_id: "group-1", sender_id: "peer", payload: encodeAlbum(refs, "Смотри") } as never;
  await useChatStore.getState().forwardMessage(message, "group-1");
  const [, payload, ids] = vi.mocked(messagesApi.send).mock.calls[0];
  const album = parseAlbum(parseForward(payload)!.body)!;
  expect(album.text).toBe("Смотри");
  expect(ids).toEqual(album.images.map((i) => i.id));
  expect(album.images.map((i) => i.id)).not.toContain(refs[0].id);
  expect(album.images.map((i) => lastByte(decryptFile(uploads.get(i.id)!, i.key)))).toEqual([1, 2]);
});

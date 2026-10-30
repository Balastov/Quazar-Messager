import "fake-indexeddb/auto";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../api/types";
import { decryptMessage } from "../../crypto/message";

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
  scheduledApi: { list: vi.fn(), create: vi.fn(), cancel: vi.fn() },
}));
vi.mock("../../ws/socket", () => ({
  socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn() },
}));

const { useE2EStore } = await import("../e2e");
useE2EStore.setState({ status: "ready" });
const { useChatStore } = await import("../chat");
const { useAuthStore } = await import("../auth");
const { scheduledApi } = await import("../../api/messages");
const { resolvePeerTrust } = await import("../../crypto/trust");

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "me", username: "я" } as never });
  useE2EStore.setState({ status: "ready" });
  useChatStore.setState({
    chats: [{ id: "direct-1", type: "direct", members: [
      { user: { id: "me", username: "я" }, role: "member" },
      { user: { id: "peer", username: "собеседник" }, role: "member" },
    ] }] as Chat[],
    scheduled: {},
  });
  vi.mocked(resolvePeerTrust).mockResolvedValue({
    status: "ok", publicKey: encodeBase64(peer.publicKey), fingerprint: null, verified: false,
  });
  vi.mocked(scheduledApi.create).mockImplementation(async (chatId, payload, at, replyToId) => ({
    id: "later-1", chat_id: chatId, payload, send_at: at.toISOString(), reply_to_id: replyToId ?? null,
    created_at: new Date().toISOString(),
  }));
});

describe("scheduled direct messages", () => {
  it("encrypts before queuing for both sender and recipient, and retains the reply and time", async () => {
    const at = new Date("2026-12-01T12:00:00Z");
    await useChatStore.getState().scheduleMessage("direct-1", "Секретный текст", at, "reply-1");
    const [chatId, ciphertext, sendAt, replyId] = vi.mocked(scheduledApi.create).mock.calls[0];
    expect([chatId, sendAt, replyId]).toEqual(["direct-1", at, "reply-1"]);
    expect(ciphertext.startsWith("ENC2:")).toBe(true);
    expect(ciphertext).not.toContain("Секретный текст");
    expect(await decryptMessage(ciphertext, { seed: mine.secretKey })).toBe("Секретный текст");
    expect(await decryptMessage(ciphertext, { seed: peer.secretKey })).toBe("Секретный текст");
    expect(useChatStore.getState().scheduled["direct-1"]).toEqual([
      { id: "later-1", text: "Секретный текст", sendAt: at.toISOString(), replyToId: "reply-1" },
    ]);
    expect(scheduledApi.list).not.toHaveBeenCalled();
  });

  it("does not queue when the recipient key changed", async () => {
    vi.mocked(resolvePeerTrust).mockResolvedValue({
      status: "changed", publicKey: encodeBase64(peer.publicKey), fingerprint: null, verified: false,
    });
    await expect(useChatStore.getState().scheduleMessage("direct-1", "Текст", new Date())).rejects.toThrow("Ключ");
    expect(scheduledApi.create).not.toHaveBeenCalled();
  });

  it("reports a missing chat instead of falsely claiming success", async () => {
    await expect(useChatStore.getState().scheduleMessage("gone", "Текст", new Date())).rejects.toThrow("Чат недоступен");
    expect(scheduledApi.create).not.toHaveBeenCalled();
  });

  it("does not let a delayed list response hide a successfully queued message", async () => {
    let finish!: (items: []) => void;
    vi.mocked(scheduledApi.list).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const loading = useChatStore.getState().loadScheduled("direct-1");
    await useChatStore.getState().scheduleMessage("direct-1", "Позже", new Date("2026-12-01T12:00:00Z"));
    finish([]);
    await loading;
    expect(useChatStore.getState().scheduled["direct-1"].map((x) => x.text)).toEqual(["Позже"]);
  });
});

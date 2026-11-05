import "fake-indexeddb/auto";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, WsEvent } from "../../api/types";
import { decryptMessage } from "../../crypto/message";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
});

const mine = nacl.box.keyPair();
const peer = nacl.box.keyPair();
const eventHandlers: ((event: WsEvent) => void)[] = [];
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
  scheduledApi: { list: vi.fn(), create: vi.fn(), cancel: vi.fn() },
}));
vi.mock("../../ws/socket", () => ({
  socket: { on: (handler: (event: WsEvent) => void) => { eventHandlers.push(handler); return () => {}; }, onStatus: () => () => {}, send: vi.fn() },
}));
vi.mock("../../notifications/notify", async original => ({
  ...await original<typeof import("../../notifications/notify")>(), notifyIncomingMessage: vi.fn(),
}));
vi.mock("../../api/chats", async original => {
  const actual = await original<typeof import("../../api/chats")>();
  return { ...actual, chatsApi: { ...actual.chatsApi, list: vi.fn() } };
});

const { useE2EStore } = await import("../e2e");
useE2EStore.setState({ status: "ready" });
const { useChatStore } = await import("../chat");
const { useAuthStore } = await import("../auth");
const { scheduledApi, messagesApi } = await import("../../api/messages");
const { resolvePeerTrust } = await import("../../crypto/trust");
const { useUnreadStore } = await import("../unread");
const { useNotifyStore } = await import("../../notifications/levels");
const { notifyIncomingMessage } = await import("../../notifications/notify");
const { chatsApi } = await import("../../api/chats");

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
    messages: {}, activeChatId: null, loadingMessages: false,
  });
  useUnreadStore.setState({ counts: {} });
  useNotifyStore.setState({ loaded: true, settings: {} });
  vi.mocked(resolvePeerTrust).mockResolvedValue({
    status: "ok", publicKey: encodeBase64(peer.publicKey), fingerprint: null, verified: false,
  });
  vi.mocked(scheduledApi.create).mockImplementation(async (chatId, payload, at, replyToId) => ({
    id: "later-1", chat_id: chatId, payload, send_at: at.toISOString(), reply_to_id: replyToId ?? null,
    created_at: new Date().toISOString(),
  }));
});

describe("release news delivery", () => {
  const newsChat = () => useChatStore.setState({ chats: [{ id: "news", type: "news", members: [
    { user: { id: "me", username: "я" }, role: "member" },
    { user: { id: "news-bot", username: "Quazar_news_bot", is_official: true }, role: "owner" },
  ] }] as Chat[] });

  it("shows one message, unread badge and notification for simultaneous and repeated events", async () => {
    newsChat();
    const event: WsEvent = { type: "new_message", message_id: "release-1", chat_id: "news", sender_id: "news-bot",
      payload: "Quazar 0.20.4 · Что нового\n• Фото профиля обновляется сразу", status: "sent", timestamp: "2026-11-05T10:00:00Z" };
    for (let attempt = 0; attempt < 2; attempt++) eventHandlers.forEach(handler => handler(event));
    await vi.waitFor(() => expect(notifyIncomingMessage).toHaveBeenCalledOnce());
    eventHandlers.forEach(handler => handler(event));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useChatStore.getState().messages.news.map(item => item.id)).toEqual(["release-1"]);
    expect(useUnreadStore.getState().counts.news).toBe(1);
    expect(notifyIncomingMessage).toHaveBeenCalledOnce();
  });

  it("does not try to send a reply to the news bot", async () => {
    newsChat();
    await expect(useChatStore.getState().sendMessage("news", "Спасибо")).rejects.toThrow("только для чтения");
    expect(messagesApi.send).not.toHaveBeenCalled();
  });

  it("discovers a new bot chat without counting its first unread message twice", async () => {
    newsChat();
    const chat = useChatStore.getState().chats[0];
    useChatStore.setState({ chats: [] });
    vi.mocked(chatsApi.list).mockResolvedValue([{ ...chat, unread_count: 1 }]);
    const event: WsEvent = { type: "new_message", message_id: "first-news", chat_id: "news", sender_id: "news-bot",
      payload: "Что нового в Quazar", status: "sent", timestamp: "2026-11-05T10:00:00Z" };
    eventHandlers.forEach(handler => handler(event));
    await vi.waitFor(() => expect(notifyIncomingMessage).toHaveBeenCalledOnce());
    expect(useChatStore.getState().chats[0].type).toBe("news");
    expect(useUnreadStore.getState().counts.news).toBe(1);
  });
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

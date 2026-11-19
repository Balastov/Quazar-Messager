import source from "../../../public/sw.js?raw";
import {afterEach, expect, it, vi} from "vitest";

function worker(opts: {presenting?: boolean} = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  // Уведомления в системе по тегу: новое с тем же тегом заменяет прежнее.
  const shown = new Map<string, {title: string; body: string; data: any}>();
  const show = vi.fn(async (title: string, options: any) => {
    if (options?.tag) shown.set(options.tag, {title, body: options.body, data: options.data});
  });
  // Открытое окно отвечает воркеру, идёт ли показ экрана; остальные сообщения просто записываем.
  const post = vi.fn((message: any, ports?: MessagePort[]) => {
    if (message?.type === "quazar-presenting?") ports?.[0]?.postMessage({presenting: !!opts.presenting});
  });
  const focus = vi.fn().mockResolvedValue(undefined);
  const getNotifications = async ({tag}: {tag: string}) => (shown.has(tag) ? [shown.get(tag)] : []);
  const self = {addEventListener: (name: string, handler: (event: any) => void) => {handlers[name] = handler;},
    registration: {scope: "https://quazar-msg.ru/", showNotification: show, getNotifications},
    clients: {matchAll: vi.fn().mockResolvedValue([{url: "https://quazar-msg.ru/", postMessage: post, focus}])}};
  new Function("self", source)(self);
  const push = async (data: object) => {
    const pending: Promise<unknown>[] = [];
    handlers.push({data: {json: () => data}, waitUntil: (promise: Promise<unknown>) => pending.push(promise)});
    await Promise.all(pending);
  };
  return {handlers, show, post, focus, push, shown};
}

it("always displays incoming star push, honors silence and reports the message id", async () => {
  const w = worker();
  const payload = {type: "star_message", title: "Звезда", message_id: "m1", star_id: "star", channel_id: "channel",
    tag: "quazar-star-message-m1", recipient_user_id: "me", silent: true};
  await w.push(payload); await w.push(payload);
  expect(w.show).toHaveBeenCalledTimes(2);
  expect(w.show).toHaveBeenLastCalledWith("Звезда", expect.objectContaining({tag: "quazar-star-channel", silent: true, renotify: false,
    data: expect.objectContaining({kind: "star", starId: "star", channelId: "channel", messageId: "m1"})}));
  expect(w.post).toHaveBeenCalledWith({type: "quazar-push-shown", messageId: "m1", userId: "me"});
});

it("displays closed-app chat push and opens the correct conversation", async () => {
  const w = worker();
  await w.push({type: "chat_message", title: "Боб", body: "Новое сообщение", message_id: "m2", chat_id: "chat", tag: "quazar-message-m2"});
  const options = w.show.mock.calls[0][1];
  expect(options.data).toEqual({kind: "message", chatId: "chat", count: 1});
  const pending: Promise<unknown>[] = [];
  w.handlers.notificationclick({notification: {data: options.data, close: vi.fn()}, waitUntil: (p: Promise<unknown>) => pending.push(p)});
  await Promise.all(pending);
  expect(w.post).toHaveBeenCalledWith({type: "quazar-open-chat", chatId: "chat"});
  expect(w.focus).toHaveBeenCalledOnce();
});

it("preserves the message and thread destination when a star notification is clicked", async () => {
  const w = worker();
  await w.push({type: "star_message", star_id: "guest-star", channel_id: "shared", message_id: "reply", thread_id: "root"});
  const pending: Promise<unknown>[] = [];
  w.handlers.notificationclick({notification: {data: w.show.mock.calls[0][1].data, close: vi.fn()}, waitUntil: (p: Promise<unknown>) => pending.push(p)});
  await Promise.all(pending);
  expect(w.post).toHaveBeenCalledWith({type: "quazar-open-star", starId: "guest-star", channelId: "shared", messageId: "reply", threadId: "root"});
});

it("acknowledges a diagnostic only after handing the notification to the system", async () => {
  const send = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", send);
  try {
    const w = worker(), id = "12345678-1234-4321-8123-123456789abc", secret = "s".repeat(43);
    await w.push({ type: "connection_test", test_id: id, receipt_secret: secret, title: "Проверка связи", body: "Тест" });
    expect(w.show).toHaveBeenCalledWith("Проверка связи", expect.objectContaining({ data: { kind: "diagnostic" } }));
    expect(w.show.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(send).toHaveBeenCalledWith(`/api/push/diagnostics/${id}/receipt`, expect.objectContaining({ method: "POST", credentials: "omit", body: JSON.stringify({ secret }) }));
    expect(w.show.mock.calls[0][1].data).not.toHaveProperty("receipt_secret");
  } finally { vi.unstubAllGlobals(); }
});
it("does not report a diagnostic as displayed if showNotification fails", async () => {
  const send = vi.fn(); vi.stubGlobal("fetch", send);
  try {
    const w = worker(); w.show.mockRejectedValue(new Error("permission denied"));
    await expect(w.push({ type: "connection_test", test_id: "12345678-1234-4321-8123-123456789abc", receipt_secret: "s".repeat(43) })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

afterEach(() => vi.useRealTimers());

const chatPush = (id: string, sentAt: string) => ({type: "chat_message", title: "Боб", body: "Новое сообщение", message_id: id,
  chat_id: "chat", tag: `quazar-message-${id}`, sent_at: sentAt});

it("folds a backlog burst into one notification per chat and rings at most once", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
  const w = worker();
  for (let i = 0; i < 10; i++) await w.push(chatPush(`m${i}`, "2026-11-18T09:59:59Z"));
  await w.push({...chatPush("other", "2026-11-18T09:59:59Z"), chat_id: "chat2", title: "Ева"});
  const calls = w.show.mock.calls.map(([, options]) => options);
  expect(new Set(calls.map((o) => o.tag))).toEqual(new Set(["quazar-chat-chat", "quazar-chat-chat2"]));
  expect(calls.filter((o) => !o.silent)).toHaveLength(1);
  expect(w.shown.get("quazar-chat-chat")).toMatchObject({body: "Новых сообщений: 10", data: {count: 10}});
  // Через паузу новое сообщение снова звенит — и заменяет то же уведомление.
  vi.setSystemTime(new Date("2026-11-18T10:00:10Z"));
  await w.push(chatPush("m10", "2026-11-18T10:00:10Z"));
  expect(w.show).toHaveBeenLastCalledWith("Боб", expect.objectContaining({tag: "quazar-chat-chat", silent: false, renotify: true}));
});

it("shows pushes that waited in the queue silently", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
  const w = worker();
  await w.push(chatPush("old", "2026-11-18T07:00:00Z"));
  expect(w.show).toHaveBeenCalledWith("Боб", expect.objectContaining({silent: true, renotify: false}));
});

it("does not duplicate a message the open page already notified about", async () => {
  const w = worker();
  w.shown.set("quazar-message-m5", {title: "Боб", body: "Новое сообщение", data: {kind: "message", chatId: "chat"}});
  await w.push(chatPush("m5", new Date().toISOString()));
  expect(w.shown.has("quazar-chat-chat")).toBe(false);
  expect(w.show).toHaveBeenCalledWith("Боб", expect.objectContaining({tag: "quazar-message-m5", silent: true}));
});

it("shows nothing while the open app is sharing its screen", async () => {
  const w = worker({presenting: true});
  await w.push({type: "incoming_call", call_id: "c1", chat_id: "chat", caller_name: "Боб"});
  await w.push({type: "star_door", door: "knock", star_id: "star", channel_id: "room", knock_id: "k1"});
  await w.push(chatPush("m1", new Date().toISOString()));
  await w.push({type: "star_message", title: "Звезда", message_id: "m2", star_id: "star", channel_id: "channel"});
  expect(w.show).not.toHaveBeenCalled();
  expect(w.post).not.toHaveBeenCalledWith(expect.objectContaining({type: "quazar-push-shown"}));
});

it("still rings for a call when the open app is not sharing its screen", async () => {
  const w = worker({presenting: false});
  await w.push({type: "incoming_call", call_id: "c2", chat_id: "chat", caller_name: "Боб"});
  expect(w.show).toHaveBeenCalledWith("Входящий звонок", expect.objectContaining({tag: "quazar-call-c2", silent: false}));
});

it("treats a page that does not answer as not sharing", async () => {
  vi.useFakeTimers();
  const w = worker();
  w.post.mockImplementation(() => undefined);
  const done = w.push({type: "incoming_call", call_id: "c3", chat_id: "chat"});
  await vi.advanceTimersByTimeAsync(300);
  await done;
  expect(w.show).toHaveBeenCalledOnce();
});

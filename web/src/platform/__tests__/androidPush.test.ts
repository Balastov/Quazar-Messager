import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  defaults: { headers: { common: {} as Record<string, string | undefined> } },
  put: vi.fn(async (..._args: unknown[]) => ({ data: { ok: true } as Record<string, unknown> })),
  post: vi.fn(async (..._args: unknown[]) => ({ data: { ok: true } as Record<string, unknown> })),
}));
vi.mock("../../api/client", () => ({ http }));

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
});

const { notificationRoute, openFromNotification, resetAndroidPush, startAndroidPush, syncAndroidPush, dropAndroidPush, testAndroidPush } =
  await import("../androidPush");
const { setNotifyPrefs } = await import("../../notifications/prefs");

type Listener = (value: unknown) => void;
function fakePlugin(permission: string) {
  const listeners = new Map<string, Listener>();
  const plugin = {
    permission,
    checkPermissions: vi.fn(async () => ({ receive: plugin.permission })),
    requestPermissions: vi.fn(async () => { plugin.permission = plugin.answer; return { receive: plugin.permission }; }),
    answer: "granted",
    // Как настоящий плагин: после register() приходит событие registration с адресом телефона.
    register: vi.fn(async () => { listeners.get("registration")?.({ value: "fcm-token-123" }); }),
    addListener: vi.fn((event: string, cb: Listener) => { listeners.set(event, cb); return { remove() {} }; }),
    emit: (event: string, value: unknown) => listeners.get(event)?.(value),
  };
  return plugin;
}
let plugin: ReturnType<typeof fakePlugin>;
function inApp(withPlugin = true) {
  (window as unknown as { Capacitor: unknown }).Capacitor = {
    getPlatform: () => "android",
    Plugins: withPlugin ? { PushNotifications: plugin } : {},
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  memory.clear();
  resetAndroidPush();
  http.put.mockClear(); http.post.mockClear();
  http.defaults.headers.common.Authorization = "Bearer jwt-alice";
  setNotifyPrefs({ enabled: true });
  plugin = fakePlugin("prompt");
  inApp();
});
afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("where a notification leads", () => {
  it("matches the browser's notification clicks", () => {
    expect(notificationRoute({ kind: "message", chatId: "c1" })).toEqual(
      { url: "/?chat=c1", event: "quazar-open-chat", detail: { chatId: "c1" } });
    expect(notificationRoute({ kind: "star", starId: "s", channelId: "ch", messageId: "m" })).toMatchObject(
      { url: "/?star=s&channel=ch&message=m", event: "quazar-open-star", detail: { starId: "s", channelId: "ch", messageId: "m", threadId: null } });
    expect(notificationRoute({ kind: "call", callId: "k", chatId: "c", callerName: "Анна", video: "1" })).toMatchObject(
      { url: "/?chat=c&call=k", event: "quazar-open-call", detail: { callId: "k", media: { audio: true, video: true } } });
    expect(notificationRoute({ kind: "door", starId: "s", channelId: "p", door: "knock", knockId: "n" })).toMatchObject(
      { url: "/?star=s&planet=p&door=knock&knock=n", event: "quazar-star-door" });
    expect(notificationRoute({ kind: "inbox", messageId: "n", starId: "s", channelId: "p" })).toMatchObject(
      { url: "/?inbox=n&star=s&channel=p", event: "quazar-open-inbox", detail: { notificationId: "n" } });
    expect(notificationRoute({ kind: "keys" })).toEqual({ url: "/", event: null, detail: null });
  });

  it("opens at once when the chats screen is there, otherwise once it says it is ready", () => {
    window.dispatchEvent(new Event("quazar-messenger-gone"));
    const seen: unknown[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("quazar-open-chat", onOpen);
    openFromNotification({ kind: "message", chatId: "c1" });
    expect(seen).toEqual([]);
    window.dispatchEvent(new Event("quazar-messenger-ready"));
    expect(seen).toEqual([{ chatId: "c1" }]);
    // Повторная готовность (перевход) старое уведомление не открывает.
    window.dispatchEvent(new Event("quazar-messenger-ready"));
    expect(seen).toHaveLength(1);

    // Экран готов — сразу; ушёл (выход из аккаунта) — снова ждём.
    openFromNotification({ kind: "message", chatId: "c2" });
    expect(seen).toEqual([{ chatId: "c1" }, { chatId: "c2" }]);
    window.dispatchEvent(new Event("quazar-messenger-gone"));
    openFromNotification({ kind: "message", chatId: "c3" });
    expect(seen).toHaveLength(2);
    window.dispatchEvent(new Event("quazar-messenger-ready"));
    expect(seen[seen.length - 1]).toEqual({ chatId: "c3" });
    window.removeEventListener("quazar-open-chat", onOpen);
  });

  it("follows a tap on a notification", () => {
    const seen: unknown[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("quazar-open-chat", onOpen);
    window.dispatchEvent(new Event("quazar-messenger-ready"));
    startAndroidPush();
    plugin.emit("pushNotificationActionPerformed", { actionId: "tap", notification: { data: { kind: "message", chatId: "c9" } } });
    expect(seen).toEqual([{ chatId: "c9" }]);
    window.removeEventListener("quazar-open-chat", onOpen);
  });
});

describe("registering the phone", () => {
  it("asks Android once, then tells the server the phone's address", async () => {
    await syncAndroidPush();
    await flush();
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.register).toHaveBeenCalledTimes(1);
    expect(http.put).toHaveBeenCalledWith("/push/fcm", { token: "fcm-token-123", app_version: undefined });
    // Тот же вход — повторно не регистрируемся.
    await syncAndroidPush();
    expect(plugin.register).toHaveBeenCalledTimes(1);
  });

  it("does not nag after a refusal unless the person turns notifications on in settings", async () => {
    plugin.answer = "prompt-with-rationale";
    await syncAndroidPush();
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.register).not.toHaveBeenCalled();
    resetAndroidPush();
    await syncAndroidPush();
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    plugin.answer = "granted";
    await syncAndroidPush({ ask: true });
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(2);
    expect(plugin.register).toHaveBeenCalledTimes(1);
  });

  it("forgets the phone on sign-out and when notifications are turned off", async () => {
    plugin.permission = "granted";
    await syncAndroidPush();
    await flush();
    await dropAndroidPush();
    expect(http.post).toHaveBeenCalledWith("/push/fcm/unregister", { token: "fcm-token-123" });

    http.post.mockClear();
    await syncAndroidPush();
    await flush();
    setNotifyPrefs({ enabled: false });
    await flush(); await flush();
    expect(http.post).toHaveBeenCalledWith("/push/fcm/unregister", { token: "fcm-token-123" });
  });

  it("checks delivery to this phone and explains a missing registration", async () => {
    expect((await testAndroidPush()).error).toMatch(/не зарегистрирован/);
    expect(http.post).not.toHaveBeenCalled();
    plugin.permission = "granted";
    await syncAndroidPush();
    await flush();
    http.post.mockResolvedValueOnce({ data: { ok: false, status: 403, error: "Ключ сервера от другого проекта Firebase" } });
    expect(await testAndroidPush()).toEqual({ ok: false, status: 403, error: "Ключ сервера от другого проекта Firebase" });
    expect(http.post).toHaveBeenCalledWith("/push/fcm/test", { token: "fcm-token-123" }, { timeout: 25_000 });
  });

  it("waits for sign-in and does nothing in old app versions or the browser", async () => {
    http.defaults.headers.common.Authorization = undefined;
    plugin.permission = "granted";
    await syncAndroidPush();
    expect(plugin.register).not.toHaveBeenCalled();

    http.defaults.headers.common.Authorization = "Bearer jwt";
    inApp(false);
    await syncAndroidPush();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    await syncAndroidPush();
    expect(http.put).not.toHaveBeenCalled();
  });
});

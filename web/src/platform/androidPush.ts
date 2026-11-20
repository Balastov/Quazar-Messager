/**
 * Уведомления в приложении Quazar для Android: Firebase Cloud Messaging через плагин Capacitor
 * (@capacitor/push-notifications). Веб-часть приходит с сайта, поэтому в старых версиях приложения
 * (без плагина) всё это молча не работает — там остаётся подсказка ANDROID_NOTIFY_HINT.
 *
 * - Вошли в аккаунт (и уведомления в настройках Quazar включены) — спрашиваем разрешение Android
 *   и сообщаем серверу адрес телефона (PUT /push/fcm).
 * - Вышли или выключили уведомления — адрес снимаем (POST /push/fcm/unregister).
 * - Нажали на уведомление — открываем то же, что сервис-воркер в браузере (web/public/sw.js).
 */
import { http } from "../api/client";
import { getNotifyPrefs, subscribeNotifyPrefs } from "../notifications/prefs";
import { androidShell, type ListenerHandle } from "./android";

export type AndroidPushPermission = "prompt" | "prompt-with-rationale" | "granted" | "denied";

export interface AndroidPushPlugin {
  checkPermissions(): Promise<{ receive: AndroidPushPermission }>;
  requestPermissions(): Promise<{ receive: AndroidPushPermission }>;
  register(): Promise<void>;
  addListener(event: string, callback: (value: never) => void): ListenerHandle | Promise<ListenerHandle>;
}

interface CapacitorGlobal {
  getPlatform?(): string;
  Plugins?: { PushNotifications?: AndroidPushPlugin };
}

/** Плагин уведомлений, если страница открыта в приложении для Android, где он есть (2.5.0+). */
export function androidPushPlugin(): AndroidPushPlugin | undefined {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (cap?.getPlatform?.() !== "android") return undefined;
  return cap.Plugins?.PushNotifications;
}

const TOKEN_KEY = "quazar-fcm-token";
/** Системный вопрос про уведомления задаём сами один раз; дальше — только по переключателю в настройках. */
const ASKED_KEY = "quazar-fcm-asked";

function storedToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

let token: string | null = null;
let started = false;
/** Для какого входа и настройки адрес уже отправлен: не регистрироваться заново на каждый чих. */
let synced: string | null = null;

/** Куда ведёт нажатие на уведомление: адрес (для холодного старта) и событие (для открытого приложения). */
export interface NotificationRoute {
  url: string;
  event: string | null;
  detail: unknown;
}

export function notificationRoute(data: Record<string, string | undefined>): NotificationRoute {
  const params = new URLSearchParams();
  const set = (key: string, value?: string) => { if (value) params.set(key, value); };
  const url = () => (params.toString() ? `/?${params}` : "/");
  switch (data.kind) {
    case "call": {
      set("chat", data.chatId); set("call", data.callId);
      return { url: url(), event: data.callId ? "quazar-open-call" : null, detail: {
        callId: data.callId ?? null, chatId: data.chatId ?? null, callerId: data.callerId ?? null,
        callerName: data.callerName ?? null, media: { audio: true, video: data.video === "1" } } };
    }
    case "door": {
      if (!data.starId || !data.channelId) break;
      set("star", data.starId); set("planet", data.channelId); set("door", data.door || "invite");
      set("knock", data.knockId); set("lobby", data.lobbyChannelId);
      return { url: url(), event: "quazar-star-door", detail: { starId: data.starId, channelId: data.channelId,
        door: data.door || "invite", knockId: data.knockId ?? null, lobbyChannelId: data.lobbyChannelId ?? null, action: null } };
    }
    case "keys":
      // Приложение само спросит «Это вы входите?», когда откроется.
      return { url: "/", event: null, detail: null };
    case "inbox": {
      set("inbox", data.messageId);
      if (data.starId && data.channelId) { set("star", data.starId); set("channel", data.channelId); }
      return { url: url(), event: "quazar-open-inbox", detail: { notificationId: data.messageId ?? null,
        starId: data.starId ?? null, channelId: data.channelId ?? null } };
    }
    case "star": {
      if (!data.starId || !data.channelId) break;
      set("star", data.starId); set("channel", data.channelId); set("message", data.messageId); set("thread", data.threadId);
      return { url: url(), event: "quazar-open-star", detail: { starId: data.starId, channelId: data.channelId,
        messageId: data.messageId ?? null, threadId: data.threadId ?? null } };
    }
  }
  if (data.chatId) {
    set("chat", data.chatId);
    return { url: url(), event: "quazar-open-chat", detail: { chatId: data.chatId } };
  }
  return { url: "/", event: null, detail: null };
}

/** Нажали на уведомление, пока экран чатов ещё не готов (приложение запускалось или вход не выполнен). */
let pending: NotificationRoute | null = null;

function dispatch(route: NotificationRoute) {
  if (route.event) window.dispatchEvent(new CustomEvent(route.event, { detail: route.detail }));
}

/** Экран чатов повесил обработчики «открыть чат / звонок / комнату». Разметка появляется раньше
 *  эффектов React, поэтому ждём явного сигнала, а не элемента на странице. */
let messengerReady = false;

/** Открыть то, о чём уведомление. Экран чатов готов — сразу; ещё нет — когда он скажет, что готов
 *  (MessengerPage шлёт «quazar-messenger-ready» и «quazar-messenger-gone»). */
export function openFromNotification(data: Record<string, string | undefined>) {
  const route = notificationRoute(data);
  if (!route.event) return;
  if (messengerReady) dispatch(route);
  else pending = route;
}

if (typeof window !== "undefined") {
  window.addEventListener("quazar-messenger-ready", () => {
    messengerReady = true;
    const route = pending;
    pending = null;
    if (route) dispatch(route);
  });
  window.addEventListener("quazar-messenger-gone", () => { messengerReady = false; });
}

async function sendToken(): Promise<void> {
  if (!token || !getNotifyPrefs().enabled || !http.defaults.headers.common.Authorization) return;
  let appVersion: string | undefined;
  try { appVersion = (await androidShell()?.info())?.versionName; } catch { /* версия — только для статистики */ }
  await http.put("/push/fcm", { token, app_version: appVersion }).catch(() => {});
}

/** Подписки на события плагина — один раз, при запуске страницы в приложении. */
export function startAndroidPush() {
  const plugin = androidPushPlugin();
  if (!plugin || started) return;
  started = true;
  token = storedToken();
  const listen = (event: string, callback: (value: never) => void) => {
    try { void Promise.resolve(plugin.addListener(event, callback)).catch(() => {}); } catch { /* без этого события */ }
  };
  listen("registration", (value: { value?: string }) => {
    if (!value?.value) return;
    token = value.value;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* адрес всё равно уйдёт на сервер */ }
    void sendToken();
  });
  listen("registrationError", (value: { error?: string }) => console.warn("Android push registration failed", value?.error));
  listen("pushNotificationActionPerformed", (value: { notification?: { data?: Record<string, string> } }) =>
    openFromNotification(value?.notification?.data ?? {}));
  // Включили или выключили уведомления в настройках Quazar.
  subscribeNotifyPrefs(() => void syncAndroidPush());
}

/** Вошли в аккаунт или включили уведомления: разрешение Android и адрес телефона — серверу.
 *  ask — спросить разрешение, даже если уже спрашивали (человек сам включает в настройках). */
export async function syncAndroidPush({ ask = false }: { ask?: boolean } = {}): Promise<void> {
  const plugin = androidPushPlugin();
  if (!plugin) return;
  startAndroidPush();
  const authorization = http.defaults.headers.common.Authorization;
  const enabled = getNotifyPrefs().enabled;
  const key = `${String(authorization)}|${enabled}`;
  if (!ask && synced === key) return;
  if (!enabled) { synced = key; await dropAndroidPush(); return; }
  if (!authorization) return;
  try {
    let { receive } = await plugin.checkPermissions();
    let asked = false;
    try { asked = localStorage.getItem(ASKED_KEY) === "1"; } catch { /* спросим */ }
    if ((receive === "prompt" || receive === "prompt-with-rationale") && (ask || !asked)) {
      try { localStorage.setItem(ASKED_KEY, "1"); } catch { /* спросим ещё раз в следующий запуск */ }
      ({ receive } = await plugin.requestPermissions());
    }
    if (receive !== "granted") return;
    synced = key;
    // Плагин ответит событием registration с адресом (каждый раз, даже если он не менялся).
    await plugin.register();
  } catch (err) {
    console.warn("Android push setup failed", err);
  }
}

/** Вышли из аккаунта или выключили уведомления: на этот телефон больше не слать. */
export async function dropAndroidPush(): Promise<void> {
  if (!androidPushPlugin() || !token) return;
  synced = null;
  await http.post("/push/fcm/unregister", { token }).catch(() => {});
}

/** Разрешение Android на уведомления (для настроек). null — не приложение или старая версия без плагина. */
export async function androidPushPermission(): Promise<AndroidPushPermission | null> {
  const plugin = androidPushPlugin();
  if (!plugin) return null;
  try { return (await plugin.checkPermissions()).receive; } catch { return null; }
}

/** Для тестов. */
export function resetAndroidPush() {
  pending = null;
  started = false;
  token = null;
  synced = null;
}

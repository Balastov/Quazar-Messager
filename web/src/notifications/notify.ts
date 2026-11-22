import { browserPermission, getNotifyPrefs } from "./prefs";
import { desktop } from "../platform/desktop";
import { playMeetingSoon, playSoftChime, soundReady } from "./sound";
import { useToastStore } from "./toastStore";
import { isDoNotDisturb } from "../store/presence";
import { isPresenting, usePresentingStore } from "./presenting";
import {acknowledgeMessage, claimNotification, isAppFocused, notificationGeneration, notificationRegistration, wasPushShown} from "./delivery";

export interface IncomingNotify {
  title: string;
  body: string;
  chatId: string;
  /** Не дублировать system notification, если чат уже открыт и вкладка видна. */
  isActiveChat: boolean;
  messageId?: string;
  recipientId?: string;
}

function truncate(text: string, max = 120): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

/** Системное уведомление звучит нашим сигналом, если страница уже может играть звук (окно в фоне,
 * но открыто): само уведомление тогда тихое. Иначе — звук системы, как раньше. */
function ownSound(sound: boolean): boolean {
  return sound && soundReady();
}

/** Сыграть сигнал после системного уведомления: свой — всегда, а если уведомление не показалось —
 * хотя бы звуком. Push об этом сообщении уже прозвенел сам — молчим. */
function playAfterShown(sound: boolean, own: boolean, shown: boolean, messageId: string | undefined, play: () => void) {
  if (!sound || wasPushShown(messageId)) return;
  if (own || !shown) play();
}

/** Push от сервера уже показал уведомление с этим тегом (и прозвенел сам). */
async function shownByPush(tag: string): Promise<boolean> {
  try {
    const reg = await notificationRegistration();
    return !!(await reg?.getNotifications({ tag }))?.length;
  } catch {
    return false;
  }
}

export async function requestNotifyPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

async function showSystemNotification(opts: {
  title: string;
  body: string;
  chatId?: string;
  starId?: string;
  channelId?: string;
  tag: string;
  requireInteraction?: boolean;
  silent?: boolean;
  kind?: "message" | "call" | "star" | "inbox";
  callId?: string;
  callerId?: string;
  actions?: { action: string; title: string }[];
  messageId?: string;
  threadId?: string | null;
}): Promise<boolean> {
  if (browserPermission() !== "granted" || isPresenting()) return false;
  const generation = notificationGeneration();

  const options: NotificationOptions & {
    actions?: { action: string; title: string }[];
    renotify?: boolean;
  } = {
    body: opts.body,
    tag: opts.tag,
    icon: "/icons/icon-192.png?v=neon-q-2",
    badge: "/icons/icon-48.png?v=neon-q-2",
    silent: opts.silent ?? true,
    requireInteraction: opts.requireInteraction ?? false,
    renotify: opts.kind === "call",
    data: {
      kind: opts.kind ?? "message",
      chatId: opts.chatId ?? null,
      starId: opts.starId ?? null,
      channelId: opts.channelId ?? null,
      callId: opts.callId ?? null,
      callerId: opts.callerId ?? null,
      callerName: opts.title,
      messageId: opts.messageId,
      threadId: opts.threadId,
    },
  };
  if (opts.actions?.length) {
    options.actions = opts.actions;
  }
  const bridge = desktop();
  if (bridge) return bridge.showNotification({ title: opts.title, body: opts.body, tag: opts.tag,
    silent: opts.silent ?? true, data: options.data }).catch(() => false);

  try {
    const reg = await notificationRegistration();
    if (generation !== notificationGeneration()) return false;
    if (wasPushShown(opts.messageId)) return true;
    if (reg?.showNotification) {
      await reg.showNotification(opts.title, options);
      return true;
    }
  } catch {
    // fall through to page Notification
  }

  try {
    if (generation !== notificationGeneration()) return false;
    const n = new Notification(opts.title, options);
    n.onclick = () => {
      window.focus();
      n.close();
      if (opts.kind === "call") {
        window.dispatchEvent(
          new CustomEvent("quazar-open-call", {
            detail: { callId: opts.callId, chatId: opts.chatId },
          })
        );
      } else if (opts.kind === "inbox") {
        window.dispatchEvent(
          new CustomEvent("quazar-open-inbox", { detail: { notificationId: opts.messageId, starId: opts.starId, channelId: opts.channelId } })
        );
      } else if (opts.kind === "star" && opts.starId && opts.channelId) {
        window.dispatchEvent(
          new CustomEvent("quazar-open-star", { detail: { starId: opts.starId, channelId: opts.channelId, messageId: opts.messageId, threadId: opts.threadId } })
        );
      } else if (opts.chatId) {
        window.dispatchEvent(
          new CustomEvent("quazar-open-chat", { detail: { chatId: opts.chatId } })
        );
      }
    };
    return true;
  } catch {
    // ignore
    return false;
  }
}

export async function notifyIncomingCall(info: {
  callId: string;
  chatId: string;
  callerId: string;
  callerName: string;
  video?: boolean;
}): Promise<void> {
  const prefs = getNotifyPrefs();
  if (!prefs.enabled || isPresenting()) return;

  if (browserPermission() === "default") {
    await requestNotifyPermission();
  }

  await showSystemNotification({
    title: info.video ? "Входящий видеозвонок" : "Входящий звонок",
    body: info.callerName || "Собеседник",
    chatId: info.chatId,
    callId: info.callId,
    callerId: info.callerId,
    tag: `quazar-call-${info.callId}`,
    kind: "call",
    requireInteraction: true,
    silent: false,
    actions: [
      { action: "accept", title: "Принять" },
      { action: "reject", title: "Отклонить" },
    ],
  });
}

export async function clearCallNotification(callId: string | null): Promise<void> {
  if (callId && desktop()) { desktop()!.closeNotification(`quazar-call-${callId}`); return; }
  if (!callId || !("serviceWorker" in navigator)) return;
  try {
    const reg = await notificationRegistration();
    if (!reg) return;
    const notes = await reg.getNotifications({ tag: `quazar-call-${callId}` });
    notes.forEach((n) => n.close());
  } catch {
    // ignore
  }
}

/** Демонстрация экрана началась — убираем уже показанные системные уведомления Quazar. */
async function clearShownNotifications(): Promise<void> {
  const bridge = desktop();
  if (bridge) { bridge.clearNotifications(); return; }
  try {
    const reg = await notificationRegistration();
    (await reg?.getNotifications())?.forEach((n) => n.close());
  } catch {
    // ignore
  }
}

usePresentingStore.subscribe((st, prev) => {
  if ((st.call || st.room) && !(prev.call || prev.room)) void clearShownNotifications();
});

export async function notifyIncomingMessage(info: IncomingNotify): Promise<void> {
  const generation = notificationGeneration();
  if (!claimNotification(info.messageId, info.recipientId)) return;
  if (info.messageId) acknowledgeMessage(info.messageId);
  const prefs = getNotifyPrefs();
  if (!prefs.enabled || isDoNotDisturb()) return;
  const foreground = isAppFocused();
  if (info.isActiveChat && foreground) return;
  if (isPresenting()) {
    playQuietly(prefs.sound, info.messageId);
    return;
  }
  const title = info.title, body = truncate(info.body || "Новое сообщение");
  if (foreground) {
    useToastStore.getState().push({title, body, chatId: info.chatId});
    if (prefs.sound) void playSoftChime();
    return;
  }
  const own = ownSound(prefs.sound);
  const shown = await showSystemNotification({title, body, chatId: info.chatId, messageId: info.messageId,
    tag: info.messageId ? `quazar-message-${info.messageId}` : `quazar-chat-${info.chatId}`, silent: !prefs.sound || own});
  if (generation !== notificationGeneration()) return;
  if (shown && info.messageId) acknowledgeMessage(info.messageId, true);
  playAfterShown(prefs.sound, own, shown, info.messageId, () => void playSoftChime());
}

/** Демонстрация экрана: только звук. Сообщение считается обработанным — сервер не пришлёт
 * этому устройству push, который показал бы системное уведомление зрителям. */
function playQuietly(sound: boolean, messageId?: string) {
  if (messageId) acknowledgeMessage(messageId, true);
  if (sound) void playSoftChime();
}

/** WebSocket и Web Push используют одинаковый тег сообщения: один видимый системный сигнал. */
export async function notifyStarMessage(info: {
  title: string; body: string; starId: string; channelId: string; messageId?: string; threadId?: string | null;
}): Promise<void> {
  const generation = notificationGeneration();
  if (!claimNotification(info.messageId)) return;
  if (info.messageId) acknowledgeMessage(info.messageId);
  const prefs = getNotifyPrefs();
  if (!prefs.enabled || isDoNotDisturb()) return;
  if (isPresenting()) {
    playQuietly(prefs.sound, info.messageId);
    return;
  }
  const body = truncate(info.body || "Новое сообщение");
  if (isAppFocused()) {
    useToastStore.getState().push({title: info.title, body, starId: info.starId, channelId: info.channelId, messageId: info.messageId, threadId: info.threadId});
    if (prefs.sound) void playSoftChime();
    return;
  }
  const own = ownSound(prefs.sound);
  const shown = await showSystemNotification({title: info.title, body, kind: "star", starId: info.starId,
    channelId: info.channelId, messageId: info.messageId, threadId: info.threadId, silent: !prefs.sound || own,
    tag: info.messageId ? `quazar-star-message-${info.messageId}` : `quazar-star-${info.channelId}`});
  if (generation !== notificationGeneration()) return;
  if (shown && info.messageId) acknowledgeMessage(info.messageId, true);
  playAfterShown(prefs.sound, own, shown, info.messageId, () => void playSoftChime());
}

/** Новое в зелёном колокольчике (брони): всплывашка в приложении, в фоне — системное уведомление.
 * Тег тот же, что у push от сервера: одно и то же не покажется дважды. id едет в поле messageId —
 * десктопное приложение пропускает в данных уведомления только известные поля. */
export async function notifyInbox(info: {
  id: string; kind?: string; title: string; body: string; starId?: string; channelId?: string;
}): Promise<void> {
  const prefs = getNotifyPrefs();
  if (!prefs.enabled || isDoNotDisturb()) return;
  // «Скоро встреча» звучит своим сигналом — не спутать с сообщением.
  const play = info.kind === "booking_soon" ? () => void playMeetingSoon() : () => void playSoftChime();
  if (isPresenting()) {
    if (prefs.sound) play();
    return;
  }
  if (isAppFocused()) {
    useToastStore.getState().push({ title: info.title, body: truncate(info.body), starId: info.starId, channelId: info.channelId, inboxId: info.id });
    if (prefs.sound) play();
    return;
  }
  const tag = `quazar-inbox-${info.id}`;
  const sound = prefs.sound && !(await shownByPush(tag));
  const own = ownSound(sound);
  const shown = await showSystemNotification({ title: info.title, body: truncate(info.body), kind: "inbox", starId: info.starId,
    channelId: info.channelId, messageId: info.id, tag, silent: !sound || own });
  playAfterShown(sound, own, shown, undefined, play);
}

/** Полный тест: toast + системное уведомление + звук (даже если звук в настройках выключен). */
export async function previewNotification(): Promise<void> {
  const title = "Quazar";
  const body = "Так выглядит уведомление о новом сообщении";

  useToastStore.getState().push({ title, body });
  void playSoftChime();

  if (browserPermission() === "default") {
    await requestNotifyPermission();
  }

  await showSystemNotification({
    title,
    body,
    tag: `quazar-preview-${Date.now()}`,
  });
}

export async function registerNotifyServiceWorker(): Promise<void> {
  if (desktop()) return;
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    // ignore — уведомления всё ещё могут работать через Notification API
  }
}

/** Что открыть по нажатию на уведомление двери комнаты (Созвездие). */
export interface DoorLink {
  starId: string;
  channelId: string;
  door: "invite" | "knock" | "admit" | "wait" | "deny" | "free";
  knockId?: string | null;
  lobbyChannelId?: string | null;
  /** Кнопка в уведомлении: join / admit / deny. */
  action?: string | null;
}

export function doorLinkUrl(link: DoorLink): string {
  const params = new URLSearchParams({ star: link.starId, planet: link.channelId, door: link.door });
  if (link.knockId) params.set("knock", link.knockId);
  if (link.lobbyChannelId) params.set("lobby", link.lobbyChannelId);
  if (link.action) params.set("do", link.action);
  return `/?${params.toString()}`;
}

/** «Вас зовут», «Стучатся», «Вас впустили» — когда вкладка скрыта. */
export async function notifyDoor(
  link: DoorLink,
  opts: { title: string; body: string; actions?: { action: string; title: string }[] }
): Promise<void> {
  const tabVisible = typeof document !== "undefined" && document.visibilityState === "visible";
  if (tabVisible || browserPermission() !== "granted" || isDoNotDisturb() || isPresenting()) return;
  const options: NotificationOptions & { actions?: { action: string; title: string }[] } = {
    body: opts.body,
    tag: `quazar-door-${link.knockId ?? link.channelId}`,
    icon: "/icons/icon-192.png?v=neon-q-2",
    badge: "/icons/icon-48.png?v=neon-q-2",
    requireInteraction: link.door === "invite" || link.door === "knock",
    data: { kind: "door", ...link },
  };
  if (opts.actions?.length) options.actions = opts.actions;
  const bridge = desktop();
  if (bridge) {
    await bridge.showNotification({ title: opts.title, body: opts.body, tag: options.tag!, silent: true, data: options.data }).catch(() => false);
    return;
  }
  try {
    const reg = await notificationRegistration();
    if (reg?.showNotification) {
      await reg.showNotification(opts.title, options);
      return;
    }
  } catch {
    // fall through
  }
  try {
    const n = new Notification(opts.title, options);
    n.onclick = () => {
      window.focus();
      n.close();
      window.dispatchEvent(new CustomEvent("quazar-star-door", { detail: link }));
    };
  } catch {
    // ignore
  }
}

/** Напоминание о сообщении: всплывашка, а если вкладка скрыта — системное уведомление.
 * Тег тот же, что у push от сервера, — одно и то же напоминание не покажется дважды. */
export async function notifyReminder(info: {
  reminderId: string;
  chatId: string;
  messageId: string;
  body: string;
}): Promise<void> {
  if (isPresenting()) {
    void playSoftChime();
    return;
  }
  useToastStore.getState().push({
    title: "🔔 Напоминание",
    body: truncate(info.body),
    chatId: info.chatId,
    messageId: info.messageId,
  });
  void playSoftChime();
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    await showSystemNotification({
      title: "Напоминание",
      body: truncate(info.body),
      chatId: info.chatId,
      tag: `quazar-reminder-${info.reminderId}`,
    });
  }
}

/** Служебная всплывашка в приложении (без звука и системных уведомлений). */
export function notifyInfo(info: { title: string; body: string; chatId?: string }): void {
  useToastStore.getState().push(info);
}

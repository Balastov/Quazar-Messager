import { browserPermission, getNotifyPrefs } from "./prefs";
import { desktop } from "../platform/desktop";
import { playSoftChime } from "./sound";
import { useToastStore } from "./toastStore";
import { isDoNotDisturb } from "../store/presence";
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
  kind?: "message" | "call" | "star";
  callId?: string;
  callerId?: string;
  actions?: { action: string; title: string }[];
  messageId?: string;
  threadId?: string | null;
}): Promise<boolean> {
  if (browserPermission() !== "granted") return false;
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
  if (!prefs.enabled) return;

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

export async function notifyIncomingMessage(info: IncomingNotify): Promise<void> {
  const generation = notificationGeneration();
  if (!claimNotification(info.messageId, info.recipientId)) return;
  if (info.messageId) acknowledgeMessage(info.messageId);
  const prefs = getNotifyPrefs();
  if (!prefs.enabled || isDoNotDisturb()) return;
  const foreground = isAppFocused();
  if (info.isActiveChat && foreground) return;
  const title = info.title, body = truncate(info.body || "Новое сообщение");
  if (foreground) {
    useToastStore.getState().push({title, body, chatId: info.chatId});
    if (prefs.sound) void playSoftChime();
    return;
  }
  const shown = await showSystemNotification({title, body, chatId: info.chatId, messageId: info.messageId,
    tag: info.messageId ? `quazar-message-${info.messageId}` : `quazar-chat-${info.chatId}`, silent: !prefs.sound});
  if (generation !== notificationGeneration()) return;
  if (shown && info.messageId) acknowledgeMessage(info.messageId, true);
  if (!shown && prefs.sound) void playSoftChime();
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
  const body = truncate(info.body || "Новое сообщение");
  if (isAppFocused()) {
    useToastStore.getState().push({title: info.title, body, starId: info.starId, channelId: info.channelId, messageId: info.messageId, threadId: info.threadId});
    if (prefs.sound) void playSoftChime();
    return;
  }
  const shown = await showSystemNotification({title: info.title, body, kind: "star", starId: info.starId,
    channelId: info.channelId, messageId: info.messageId, threadId: info.threadId, silent: !prefs.sound,
    tag: info.messageId ? `quazar-star-message-${info.messageId}` : `quazar-star-${info.channelId}`});
  if (generation !== notificationGeneration()) return;
  if (shown && info.messageId) acknowledgeMessage(info.messageId, true);
  if (!shown && prefs.sound) void playSoftChime();
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
  if (tabVisible || browserPermission() !== "granted" || isDoNotDisturb()) return;
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

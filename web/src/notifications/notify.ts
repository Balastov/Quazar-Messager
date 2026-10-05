import { browserPermission, getNotifyPrefs } from "./prefs";
import { playSoftChime } from "./sound";
import { useToastStore } from "./toastStore";

export interface IncomingNotify {
  title: string;
  body: string;
  chatId: string;
  /** Не дублировать system notification, если чат уже открыт и вкладка видна. */
  isActiveChat: boolean;
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
  tag: string;
  requireInteraction?: boolean;
  silent?: boolean;
  kind?: "message" | "call";
  callId?: string;
  callerId?: string;
  actions?: { action: string; title: string }[];
}): Promise<void> {
  if (browserPermission() !== "granted") return;

  const options: NotificationOptions & {
    actions?: { action: string; title: string }[];
    renotify?: boolean;
  } = {
    body: opts.body,
    tag: opts.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-48.png",
    silent: opts.silent ?? true,
    requireInteraction: opts.requireInteraction ?? false,
    renotify: opts.kind === "call",
    data: {
      kind: opts.kind ?? "message",
      chatId: opts.chatId ?? null,
      callId: opts.callId ?? null,
      callerId: opts.callerId ?? null,
      callerName: opts.title,
    },
  };
  if (opts.actions?.length) {
    options.actions = opts.actions;
  }

  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.showNotification) {
      await reg.showNotification(opts.title, options);
      return;
    }
  } catch {
    // fall through to page Notification
  }

  try {
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
      } else if (opts.chatId) {
        window.dispatchEvent(
          new CustomEvent("quazar-open-chat", { detail: { chatId: opts.chatId } })
        );
      }
    };
  } catch {
    // ignore
  }
}

export async function notifyIncomingCall(info: {
  callId: string;
  chatId: string;
  callerId: string;
  callerName: string;
}): Promise<void> {
  const prefs = getNotifyPrefs();
  if (!prefs.enabled) return;

  if (browserPermission() === "default") {
    await requestNotifyPermission();
  }

  await showSystemNotification({
    title: "Входящий звонок",
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
  if (!callId || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const notes = await reg.getNotifications({ tag: `quazar-call-${callId}` });
    notes.forEach((n) => n.close());
  } catch {
    // ignore
  }
}

export async function notifyIncomingMessage(info: IncomingNotify): Promise<void> {
  const prefs = getNotifyPrefs();
  if (!prefs.enabled) return;

  const tabHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  // Чат уже на экране — сообщение появится само, без toast/звука.
  if (info.isActiveChat && !tabHidden) return;

  const title = info.title;
  const body = truncate(info.body || "Новое сообщение");

  useToastStore.getState().push({
    title,
    body,
    chatId: info.chatId,
  });

  if (prefs.sound) {
    void playSoftChime();
  }

  await showSystemNotification({
    title,
    body,
    chatId: info.chatId,
    tag: `quazar-chat-${info.chatId}`,
  });
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
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    // ignore — уведомления всё ещё могут работать через Notification API
  }
}

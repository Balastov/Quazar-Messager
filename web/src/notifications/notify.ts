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

  const permission = browserPermission();
  if (permission === "granted") {
    try {
      const n = new Notification(title, {
        body,
        tag: `quazar-chat-${info.chatId}`,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-48.png",
        silent: true, // свой звук уже сыграли
      });
      n.onclick = () => {
        window.focus();
        n.close();
        window.dispatchEvent(
          new CustomEvent("quazar-open-chat", { detail: { chatId: info.chatId } })
        );
      };
    } catch {
      // ignore — некоторые браузеры режут Notification без SW
    }
  }
}

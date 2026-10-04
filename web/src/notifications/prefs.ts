/** Локальные настройки уведомлений (на устройство / браузер). */

const STORAGE_KEY = "quazar-notify-prefs";

export interface NotifyPrefs {
  /** Пользователь хочет получать уведомления. */
  enabled: boolean;
  /** Мягкий звук при новом сообщении. */
  sound: boolean;
  /** Баннер «включить уведомления» уже скрывали. */
  promptDismissed: boolean;
}

const DEFAULTS: NotifyPrefs = {
  enabled: true,
  sound: true,
  promptDismissed: false,
};

function read(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs>;
    return {
      enabled: parsed.enabled ?? DEFAULTS.enabled,
      sound: parsed.sound ?? DEFAULTS.sound,
      promptDismissed: parsed.promptDismissed ?? DEFAULTS.promptDismissed,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getNotifyPrefs(): NotifyPrefs {
  return read();
}

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...read(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("quazar-notify-prefs", { detail: next }));
  return next;
}

export function subscribeNotifyPrefs(cb: (prefs: NotifyPrefs) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<NotifyPrefs>).detail;
    cb(detail ?? read());
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb(read());
  };
  window.addEventListener("quazar-notify-prefs", handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("quazar-notify-prefs", handler);
    window.removeEventListener("storage", onStorage);
  };
}

export function browserPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

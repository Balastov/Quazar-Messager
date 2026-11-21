import { http } from "../api/client";
import { desktop } from "../platform/desktop";
import { ANDROID_NOTIFY_HINT, inAndroidApp } from "../platform/android";
import { inIosApp, IOS_NOTIFY_HINT } from "../platform/ios";
import { androidPushPlugin } from "../platform/androidPush";

/** В приложении для Android с уведомлениями — куда смотреть, если они не приходят. */
export const ANDROID_APP_PUSH_HELP =
  "Проверьте, что уведомления Quazar включены в настройках Android (Приложения → Quazar → Уведомления), " +
  "и что не включён режим «Не беспокоить» или экономия заряда для Quazar.";
import { browserPermission, getNotifyPrefs } from "./prefs";
import { requestNotifyPermission } from "./notify";
import { diagnosticPushEndpoint } from "./push";
import { socket } from "../ws/socket";

export interface ConnectionCheck { id: string; state: "queued" | "sent" | "displayed" | "failed" | "expired"; error_code: string | null; expires_at: string }
export const CHECK_ERRORS: Record<string, string> = {
  subscription_missing: "Подписка этого устройства не найдена. Переподключите уведомления и повторите проверку.",
  subscription_expired: "Подписка устарела. Переподключите уведомления и повторите проверку.",
  transport_error: "Сервис уведомлений не принял проверку. Проверьте сеть и попробуйте ещё раз.",
  not_configured: "На сервере не настроена доставка фоновых уведомлений.",
  unsupported_provider: "Сервис уведомлений этого браузера пока не поддерживается проверкой.",
  desktop_offline: "Приложение не подключено к серверу. Проверьте сеть и повторите попытку.",
};
export function notificationHelp(): string {
  if (androidPushPlugin()) return ANDROID_APP_PUSH_HELP;
  if (inAndroidApp()) return ANDROID_NOTIFY_HINT;
  if (inIosApp()) return IOS_NOTIFY_HINT;
  if (desktop()) return "Проверьте разрешение уведомлений для Quazar в настройках системы и режим «Не беспокоить».";
  const ios = /iPhone|iPad/.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
  return ios ? "На iPhone/iPad откройте Quazar с экрана «Домой». В настройках системы проверьте уведомления для Quazar и режим «Фокусирование»."
    : "Разрешите уведомления в настройках сайта и системы. Проверьте режим «Не беспокоить» и ограничения фоновой работы браузера.";
}
async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer!); }
}
export async function prepareNotificationCheck(): Promise<{ transport: "desktop" | "push"; endpoint?: string }> {
  if (!getNotifyPrefs().enabled) throw new Error("Уведомления о сообщениях выключены. Включите переключатель выше и повторите проверку.");
  if (desktop()) {
    if (!await socket.waitUntilOpen(4000)) throw new Error(CHECK_ERRORS.desktop_offline);
    return { transport: "desktop" };
  }
  if (androidPushPlugin()) {
    // Проверка связи шлёт web push в браузер; в приложение уведомления идут через Firebase.
    throw new Error("В приложении для Android эта проверка пока недоступна. Попросите кого-нибудь написать вам, " +
      "когда Quazar свёрнут. Если уведомление не пришло: " + ANDROID_APP_PUSH_HELP);
  }
  let permission = browserPermission();
  if (permission === "default") permission = await requestNotifyPermission();
  if (permission === "unsupported" && inAndroidApp()) throw new Error(ANDROID_NOTIFY_HINT);
  if (permission === "unsupported" && inIosApp()) throw new Error(IOS_NOTIFY_HINT);
  if (permission !== "granted") throw new Error(permission === "unsupported" ? "Этот режим браузера не поддерживает системные уведомления. " + notificationHelp()
    : "Нет разрешения на уведомления. " + notificationHelp());
  const { data } = await http.get<{ configured: boolean }>("/push/vapid-public-key", { timeout: 8000 });
  if (!data.configured) throw new Error(CHECK_ERRORS.not_configured);
  const endpoint = await bounded(diagnosticPushEndpoint(), 10_000, "Не удалось подключить уведомления к серверу. Проверьте сеть и обновите страницу.");
  if (!endpoint) throw new Error("Не удалось зарегистрировать это устройство для фоновых уведомлений. Обновите Quazar и повторите проверку. " + notificationHelp());
  return { transport: "push", endpoint };
}

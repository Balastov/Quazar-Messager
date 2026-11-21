/**
 * Quazar для iOS — обёртка над веб-версией (Capacitor, ios/). Интерфейс приходит с сервера, как и в
 * приложении для Android. Пока это проба через TestFlight: своих уведомлений (APNs) и звонков
 * (CallKit) в нём ещё нет.
 */
interface CapacitorGlobal {
  getPlatform?(): string;
}

/** Страница открыта внутри приложения для iOS. */
export function inIosApp(): boolean {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.getPlatform?.() === "ios";
}

/** Встроенный браузер iOS не умеет веб-уведомления, а своих push в приложении пока нет. */
export const IOS_NOTIFY_HINT =
  "В этой версии приложения для iPhone уведомления пока не приходят — они появятся в следующих сборках. " +
  "Чтобы не пропускать сообщения и звонки, откройте quazar-msg.ru в Safari, добавьте на экран «Домой» " +
  "и разрешите уведомления там.";

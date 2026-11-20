/**
 * Quazar для Android — обёртка над веб-версией (Capacitor). Интерфейс приходит с сервера, а сама
 * обёртка обновляется APK-файлом с quazar-msg.ru: файл объявлен в /desktop-updates/android/latest.json,
 * качает и проверяет его нативный модуль QuazarUpdater, ставит — системный установщик Android.
 */

export interface AndroidAppInfo {
  versionName: string;
  versionCode: number;
  /** Разрешено ли Quazar ставить обновления («Установка неизвестных приложений»). */
  canInstall: boolean;
}

export interface ListenerHandle { remove(): unknown }

export interface AndroidUpdater {
  info(): Promise<AndroidAppInfo>;
  install(options: { url: string; sha256: string; versionCode: number }): Promise<void>;
  allowInstalls(): Promise<void>;
  /** Голый мост Capacitor отдаёт подписку сразу, обёртка @capacitor/core — обещанием: бывает и так, и так. */
  addListener(event: "progress", callback: (data: { percent: number }) => void): ListenerHandle | Promise<ListenerHandle>;
}

interface CapacitorGlobal {
  getPlatform?(): string;
  Plugins?: { QuazarUpdater?: AndroidUpdater };
}

/** Страница открыта внутри приложения для Android (даже если модуль обновления не загрузился). */
export function inAndroidApp(): boolean {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.getPlatform?.() === "android";
}

/** Встроенный браузер Android не умеет веб-уведомления, а своих push в приложении пока нет. */
export const ANDROID_NOTIFY_HINT =
  "В приложении для Android уведомления пока не приходят. Чтобы не пропускать сообщения и звонки, " +
  "откройте quazar-msg.ru в Chrome и разрешите там уведомления — они будут приходить, даже когда Chrome свёрнут.";

/** Модуль обновления, если страница открыта внутри приложения для Android. */
export function androidShell(): AndroidUpdater | undefined {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (cap?.getPlatform?.() !== "android") return undefined;
  return cap.Plugins?.QuazarUpdater;
}

export interface AndroidRelease {
  version: string;
  versionCode: number;
  url: string;
  sha256: string;
}

export const ANDROID_FEED = "/desktop-updates/android/latest.json";
export const ANDROID_UPDATE_POLL_INTERVAL = 6 * 60 * 60_000;

/** Файл обновлений с сервера; null — нет или он некорректен (лучше промолчать, чем звать в никуда).
 *  APK — только с этого же сервера (в приложении это quazar-msg.ru). */
export function parseAndroidRelease(value: unknown, origin = window.location.origin): AndroidRelease | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "string" || !/^\d+\.\d+\.\d+$/.test(v.version)) return null;
  if (typeof v.versionCode !== "number" || !Number.isInteger(v.versionCode) || v.versionCode <= 0) return null;
  if (typeof v.url !== "string" || !v.url.startsWith(`${origin}/desktop-updates/android/`) || v.url.includes("..")) return null;
  if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) return null;
  return { version: v.version, versionCode: v.versionCode, url: v.url, sha256: v.sha256 };
}

export async function latestAndroidRelease(signal?: AbortSignal): Promise<AndroidRelease | null> {
  const response = await fetch(ANDROID_FEED, { cache: "no-store", signal });
  if (!response.ok) return null;
  return parseAndroidRelease(await response.json());
}

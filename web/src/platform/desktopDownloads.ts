/** android — телефон или планшет на Android (для него есть APK), mobile — остальные (iPhone, iPad…). */
export type DownloadOS = "windows" | "mac" | "android" | "mobile" | "other";
export interface BrowserPlatform {
  userAgent: string; platform?: string; maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
}

// Указатель на опубликованный релиз: версия сайта может быть новее десктопной сборки.
export const DESKTOP_RELEASE = { version: "2.2.0", tag: "desktop-v2.2.0-pilot.1" };
const RELEASE_BASE = `https://github.com/Balastov/Quazar-Messager/releases/download/${DESKTOP_RELEASE.tag}`;
// Опубликованная сборка для Android; null — ещё не выпускали (сайт пишет «почти готово»).
// Ставится после публикации, как и DESKTOP_RELEASE.
export const ANDROID_RELEASE: { version: string } | null = { version: "2.2.0" };
export function androidApkUrl(release: { version: string }): string {
  return `https://quazar-msg.ru/desktop-updates/android/Quazar-${release.version}-android.apk`;
}
export const DESKTOP_INSTALLERS = {
  windows: { name: "Windows x64", url: `${RELEASE_BASE}/Quazar-${DESKTOP_RELEASE.version}-win-x64.exe` },
  macArm: { name: "Mac с чипом Apple (M1 и новее)", url: `${RELEASE_BASE}/Quazar-${DESKTOP_RELEASE.version}-mac-arm64.dmg` },
  macIntel: { name: "Mac с процессором Intel", url: `${RELEASE_BASE}/Quazar-${DESKTOP_RELEASE.version}-mac-x64.dmg` },
};

export function detectDownloadOS(browser: BrowserPlatform): DownloadOS {
  const ua = browser.userAgent;
  const platform = browser.userAgentData?.platform || browser.platform || "";
  if (/Android/i.test(platform) || /Android/i.test(ua)) return "android";
  if (browser.userAgentData?.mobile || /iOS|iPhone|iPad|iPod/i.test(platform) ||
      /Android|iPhone|iPad|iPod|Windows Phone|Tablet|Kindle|Silk|PlayBook|BlackBerry|webOS/i.test(ua) ||
      (/Mac/i.test(platform) && (browser.maxTouchPoints ?? 0) > 1)) return "mobile";
  if (/Windows|^Win/i.test(platform) || /Windows NT/i.test(ua)) return "windows";
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac";
  return "other";
}

export const DOWNLOAD_PROMPT_KEY = "quazar.desktop-download-prompt.v1";
export const DOWNLOAD_OFFER_DELAY = 20_000;
const DAY = 24 * 60 * 60_000;
export interface DownloadPreference { never: boolean; nextAt: number }
export type DownloadAnswer = "yes" | "later" | "no";
export function downloadPreference(answer: DownloadAnswer, never: boolean, now = Date.now()): DownloadPreference {
  return { never: never || answer === "yes", nextAt: now + (answer === "later" ? 7 : 30) * DAY };
}
export function parseDownloadPreference(value: string | null): DownloadPreference | null {
  try {
    const result = JSON.parse(value ?? "null");
    return result && typeof result.never === "boolean" && Number.isFinite(result.nextAt) && result.nextAt >= 0
      ? { never: result.never, nextAt: result.nextAt } : null;
  } catch { return null; }
}

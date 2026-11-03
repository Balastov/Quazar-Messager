import { desktop, publicOrigin } from "../platform/desktop";

const KEY = "quazar.desktop.yandexVerifier";
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function desktopYandexParams(): Promise<Record<string, string>> {
  if (!desktop()) return {};
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  // Секрет переживает перезапуск, если ОС открывает возврат уже в новом процессе.
  localStorage.setItem(KEY, JSON.stringify({ verifier, expires: Date.now() + 30 * 60_000 }));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { client: "desktop", challenge };
}
export function desktopYandexVerifier(): string | undefined {
  if (!desktop()) return undefined;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return saved && saved.expires > Date.now() && typeof saved.verifier === "string" ? saved.verifier : undefined;
  } catch { return undefined; }
}
export function forgetDesktopYandex() { if (desktop()) localStorage.removeItem(KEY); }
export function openYandex(url: string): Promise<void> {
  const bridge = desktop();
  if (bridge) return bridge.openAuth(url);
  window.location.assign(url); return Promise.resolve();
}
export async function startDesktopYandexLogin() {
  const params = await desktopYandexParams();
  await openYandex(`${publicOrigin()}/api/auth/yandex/start?${new URLSearchParams(params)}`);
}

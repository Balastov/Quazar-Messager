/**
 * Подтверждение через Яндекс ID для аккаунтов без пароля: перед тем как задать пароль или
 * сменить ключи шифрования. Код живёт в sessionStorage, пока человек ходит в Яндекс и обратно.
 */
import { authApi } from "../api/auth";

const CODE_KEY = "quazar.yandexReauth";
const PURPOSE_KEY = "quazar.yandexReauthPurpose";

/** Куда вернуть после подтверждения: в настройки или просто в приложение (окно ключей откроется само). */
export type ReauthPurpose = "settings" | "app";

export function reauthCode(): string | null {
  return sessionStorage.getItem(CODE_KEY);
}

export function saveReauthCode(code: string): ReauthPurpose {
  sessionStorage.setItem(CODE_KEY, code);
  return (sessionStorage.getItem(PURPOSE_KEY) as ReauthPurpose | null) ?? "settings";
}

/** Код одноразовый — после действия (удачного или нет) он больше не годится. */
export function clearReauth(): void {
  sessionStorage.removeItem(CODE_KEY);
  sessionStorage.removeItem(PURPOSE_KEY);
}

export async function startReauth(purpose: ReauthPurpose): Promise<void> {
  sessionStorage.setItem(PURPOSE_KEY, purpose);
  window.location.assign((await authApi.yandexReauth()).url);
}

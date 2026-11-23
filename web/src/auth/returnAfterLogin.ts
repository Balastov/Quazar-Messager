/**
 * Куда вернуться после входа: страница «Войти в Padma через Квазар» отправляет на /auth,
 * а после входа (паролем, звонком, по QR, через Яндекс) человека возвращают на неё же —
 * с теми же параметрами, в том числе после обновления вкладки.
 *
 * Возвращаем только на /oauth/authorize: адрес из хранилища не должен вести куда угодно.
 */
const KEY = "quazar-return-after-login";
const ALLOWED = /^\/oauth\/authorize\?[^#]*$/;

export interface PendingReturn {
  path: string;
  /** Кому отдаём вход — для подсказки на странице входа («Padma»). */
  name: string;
}

export function rememberReturn(path: string, name: string): void {
  if (!ALLOWED.test(path)) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ path, name })); } catch { /* без хранилища — просто на главную */ }
}

export function pendingReturn(): PendingReturn | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Partial<PendingReturn> | null;
    if (value && typeof value.path === "string" && ALLOWED.test(value.path) && typeof value.name === "string") {
      return { path: value.path, name: value.name };
    }
  } catch { /* повреждённая запись — как будто её нет */ }
  return null;
}

/** Адрес после входа: страница авторизации, если вход начался с неё, иначе — главная. */
export function pathAfterLogin(): string {
  return pendingReturn()?.path ?? "/";
}

export function clearReturn(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Как вошли в этой вкладке: после входа по коду от Quazar_Admin_bot переписку открывают там, куда пришёл код. */
const KEY = "quazar_login_via";

export function markLoginByCode(): void {
  try { sessionStorage.setItem(KEY, "code"); } catch { /* ignore */ }
}

export function loggedInByCode(): boolean {
  try { return sessionStorage.getItem(KEY) === "code"; } catch { return false; }
}

export function forgetLoginMethod(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

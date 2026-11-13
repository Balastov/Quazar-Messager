export interface BitrixContext {
  portal: string;
  employee_id: string;
  display_name: string;
  mode: "install" | "launch";
  account_linking_available: boolean;
}

let pending: Promise<BitrixContext> | undefined;

/** One exchange even under React StrictMode. No token is persisted. */
export function launchContext(): Promise<BitrixContext> {
  if (pending) return pending;
  const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  pending = (async () => {
    if (!code) throw new Error("Откройте Квазар из меню Битрикс24.");
    const response = await fetch("/api/integrations/bitrix24/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "omit", cache: "no-store", body: JSON.stringify({ code }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Б24 не подтвердил запуск.");
    return data;
  })();
  return pending;
}

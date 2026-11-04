import { useEffect, useState } from "react";
import { desktop, type DesktopUpdate } from "../platform/desktop";
import s from "./DesktopUpdates.module.css";

export default function DesktopUpdates() {
  const bridge = desktop();
  const [state, setState] = useState<DesktopUpdate>();
  const [dismissed, setDismissed] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let received = false;
    const off = bridge.onUpdate(value => { received = true; setState(value); setError(""); if (value.requested) setDismissed(""); });
    void bridge.updateState().then(value => { if (active && !received) setState(value); }).catch(() => {});
    return () => { active = false; off(); };
  }, [bridge]);
  if (!bridge || !state || !["available", "downloading", "downloaded"].includes(state.status)) return null;
  const key = `${state.version}:${state.status}`;
  if (dismissed === key) return null;
  const install = async () => {
    setBusy(true); setError("");
    try { const result = await bridge.installUpdate(); if (!result.ok) setError(result.reason ?? "Не удалось установить обновление"); }
    catch { setError("Не удалось начать обновление. Повторите попытку."); }
    finally { setBusy(false); }
  };
  return <aside className={s.banner} aria-label="Обновление Quazar">
    <div role="status"><strong>{state.status === "downloading" ? `Загружаем обновление: ${state.progress ?? 0}%` : `Доступна версия ${state.version}`}</strong>
      <p>{state.manual ? "Скачайте новую сборку для Mac и замените приложение. Ваши данные сохранятся."
        : state.status === "downloaded" ? "Обновление готово. Можно установить сейчас или при следующем запуске приложения." : "Скачиваем новую версию в фоне."}</p></div>
    <div className={s.actions}>
      {(state.status === "downloaded" || state.manual) && <button type="button" disabled={busy} onClick={() => void install()}>
        {state.manual ? "Скачать для Mac" : "Установить и перезапустить"}</button>}
      <button type="button" onClick={() => setDismissed(key)}>Позже</button>
    </div>
    {error && <p className={s.error} role="alert">{error}</p>}
  </aside>;
}

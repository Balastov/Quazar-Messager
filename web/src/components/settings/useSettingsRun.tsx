import { useState } from "react";
import axios from "axios";
import s from "../SettingsView.module.css";

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg);
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Действие раздела настроек: блокирует кнопки и показывает итог внизу раздела. */
export function useSettingsRun() {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setError(apiErrorMessage(err, "Ошибка"));
    } finally {
      setBusy(false);
    }
  };

  const feedback = (
    <>
      {status && <div className={s.statusOk} role="status">{status}</div>}
      {error && <div className={s.statusErr} role="alert">{error}</div>}
    </>
  );

  return { busy, run, setStatus, setError, feedback };
}

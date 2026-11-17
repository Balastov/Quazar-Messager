import { useEffect, useRef, useState } from "react";
import { authApi, type CodeLoginStart } from "../../api/auth";
import { apiErrorText } from "../../utils/profile";
import { CODE_LENGTH, normalizeCode, secondsUntil } from "./loginCode";
import settings from "../SettingsView.module.css";
import s from "./CodeLogin.module.css";

/**
 * Вход по коду: Quazar_Admin_bot присылает 5 цифр в чат на устройствах, где человек уже вошёл
 * (телефон → ПК, ПК → ноутбук), когда QR отсканировать нечем.
 */
export default function CodeLogin({ phone, disabled = false, onToken }: {
  phone: string | null; disabled?: boolean; onToken(token: string): Promise<void>;
}) {
  const [attempt, setAttempt] = useState<CodeLoginStart | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [, tick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  const waitResend = attempt ? secondsUntil(attempt.resend_at) : 0;
  useEffect(() => {
    if (!waitResend) return;
    const timer = setTimeout(() => tick(value => value + 1), 1000);
    return () => clearTimeout(timer);
  });

  const send = async () => {
    if (!phone || busy) return;
    setBusy(true); setError("");
    try {
      setAttempt(await authApi.codeLoginStart(phone));
      setCode("");
      requestAnimationFrame(() => input.current?.focus());
    } catch (err) {
      setError(apiErrorText(err, "Не удалось отправить код"));
    } finally { setBusy(false); }
  };

  const check = async (value: string) => {
    if (!attempt || value.length !== CODE_LENGTH || sending.current) return;
    sending.current = true;
    setBusy(true); setError("");
    try {
      const { access_token } = await authApi.codeLoginComplete(attempt.login_token, value);
      await onToken(access_token);
    } catch (err) {
      setError(apiErrorText(err, "Не удалось войти"));
      setCode("");
      // Поле ещё заблокировано — фокус после перерисовки.
      requestAnimationFrame(() => input.current?.focus());
    } finally { sending.current = false; setBusy(false); }
  };

  if (!attempt) return <div className={s.root}>
    <button type="button" className={settings.secondary} disabled={!phone || busy || disabled} onClick={() => void send()}>
      {busy ? "Отправляем код…" : "Получить код в Quazar"}
    </button>
    {error && <p className={settings.statusErr} role="alert">{error}</p>}
  </div>;

  return <div className={s.root} role="group" aria-label="Вход по коду">
    <p className={settings.hint}>
      Код пришёл от <b>Quazar_Admin_bot</b> — откройте Quazar на телефоне или компьютере, где вы уже вошли.
    </p>
    <input ref={input} className={s.code} value={code} aria-label="Код из сообщения"
      placeholder={"•".repeat(CODE_LENGTH)} inputMode="numeric" autoComplete="one-time-code" maxLength={CODE_LENGTH + 2}
      disabled={busy || disabled}
      onChange={event => {
        const value = normalizeCode(event.target.value);
        setCode(value); setError("");
        if (value.length === CODE_LENGTH) void check(value);
      }} />
    {error && <p className={settings.statusErr} role="alert">{error}</p>}
    <button type="button" className={s.resend} disabled={busy || disabled || waitResend > 0} onClick={() => void send()}>
      {waitResend > 0 ? `Новый код — через ${waitResend} с` : "Отправить код ещё раз"}
    </button>
  </div>;
}

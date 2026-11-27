import { useEffect, useRef, useState } from "react";
import { phoneVerificationApi, type PhoneVerification as Attempt, type PhoneMode } from "../../api/phoneVerification";
import { useAuthStore } from "../../store/auth";
import { apiErrorText } from "../../utils/profile";
import { formatPhoneDisplay, verifiesByTelegram } from "../../utils/phone";
import s from "../SettingsView.module.css";
import layout from "./PhoneVerification.module.css";

export default function PhoneVerification({ phone, account = false, proof, onVerified, buttonLabel = "Подтвердить телефон звонком", disabled = false }: {
  phone: string; account?: PhoneMode; proof?: string; onVerified: (token: string) => void; buttonLabel?: string; disabled?: boolean;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  // Номера не на +7 подтверждаются кодом в Telegram: звонить на российский номер из-за границы дорого.
  const telegram = attempt?.method ? attempt.method === "telegram" : verifiesByTelegram(phone);
  const label = telegram ? buttonLabel.replace("звонком", "кодом из Telegram") : buttonLabel;
  const [error, setError] = useState<string | null>(null);
  const round = useRef(0);
  const previousProof = useRef(proof);
  useEffect(() => {
    if (previousProof.current && !proof) {
      setAttempt(null);
      try { sessionStorage.removeItem(`quazar-phone-check:${account}:${phone}`); } catch { /* optional */ }
    }
    previousProof.current = proof;
  }, [proof, account, phone]);
  const callback = useRef(onVerified); callback.current = onVerified;
  useEffect(() => {
    round.current++; setAttempt(null); setBusy(false); setError(null); setCode("");
    try {
      const saved = account === "reauth" ? null : JSON.parse(sessionStorage.getItem(`quazar-phone-check:${account}:${phone}`) ?? "null");
      if (saved?.phone === phone && saved.verification_token && Date.parse(saved.expires_at) > Date.now()) {
        setAttempt({ ...saved, state: "pending" });
      }
    } catch { /* Проверка работает и без хранилища браузера. */ }
    return () => { round.current++; };
  }, [phone, account]);
  useEffect(() => {
    if (!attempt?.verification_token || attempt.state !== "pending" || attempt.method === "telegram") return;
    const token = attempt.verification_token, current = round.current;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await phoneVerificationApi.status(token, account);
        if (!active || current !== round.current) return;
        if (result.access_token) await useAuthStore.getState().refreshSession(result.access_token);
        if (!active || current !== round.current) return;
        setError(null); setAttempt({ ...result, verification_token: token });
        if (result.state === "verified") callback.current(token);
        else if (result.state === "pending") timer = setTimeout(poll, 4000);
      } catch (err) {
        if (!active || current !== round.current) return;
        setError(apiErrorText(err, "Не удалось проверить звонок"));
        timer = setTimeout(poll, 8000);
      }
    };
    timer = setTimeout(poll, 4000);
    return () => { active = false; clearTimeout(timer); };
  }, [attempt?.verification_token, attempt?.state, attempt?.method, account]);
  const start = async () => {
    if (busy || disabled) return;
    const current = ++round.current, previous = attempt;
    setBusy(true); setError(null); setAttempt(null); setCode("");
    try {
      const result = await phoneVerificationApi.start(phone, account);
      if (current === round.current) {
        setAttempt(result);
        try { sessionStorage.setItem(`quazar-phone-check:${account}:${phone}`, JSON.stringify(result)); } catch { /* optional */ }
      }
    } catch (err) {
      // Повторную отправку отклонили (лимит раз в минуту) — прежний код остаётся в силе.
      if (current === round.current) { setAttempt(previous); setError(apiErrorText(err, "Не удалось начать проверку")); }
    } finally { if (current === round.current) setBusy(false); }
  };
  const submitCode = async () => {
    const token = attempt?.verification_token, digits = code.replace(/\D/g, "");
    if (!token || busy || digits.length !== 6) return;
    const current = round.current;
    setBusy(true); setError(null);
    try {
      const result = await phoneVerificationApi.status(token, account, digits);
      if (current !== round.current) return;
      if (result.access_token) await useAuthStore.getState().refreshSession(result.access_token);
      if (current !== round.current) return;
      setAttempt({ ...result, verification_token: token });
      if (result.state === "verified") callback.current(token);
      else setCode("");
    } catch (err) {
      if (current === round.current) { setCode(""); setError(apiErrorText(err, "Не удалось проверить код")); }
    } finally { if (current === round.current) setBusy(false); }
  };
  if (proof || attempt?.state === "verified") return <p className={s.statusOk} role="status">✓ {account === "reauth" ? "Действие подтверждено" : "Телефон подтверждён"}</p>;
  return <div className={layout.root} role="group" aria-label="Подтверждение телефона">
    {attempt?.state === "pending" && telegram ? <>
      <p className={s.hint}>Мы отправили код сообщением в Telegram аккаунта с номером {formatPhoneDisplay(phone)}. Код действует 5 минут.</p>
      {/* Не form: компонент стоит внутри формы входа, а вложенные формы браузеры не поддерживают. */}
      <div className={layout.codeRow}>
        <input className={`${s.input} ${layout.codeInput}`} type="text" inputMode="numeric" autoComplete="one-time-code" aria-label="Код из Telegram"
          placeholder="000000" maxLength={7} value={code} disabled={busy} autoFocus
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void submitCode(); } }}
          onChange={event => { setCode(event.target.value.replace(/[^\d]/g, "").slice(0, 6)); setError(null); }} />
        <button type="button" className={s.primary} disabled={busy || code.length !== 6} onClick={() => void submitCode()}>{busy ? "Проверяем…" : "Подтвердить"}</button>
      </div>
      <button type="button" className={s.secondary} disabled={busy || disabled} onClick={() => void start()}>Отправить код ещё раз</button>
    </> : attempt?.state === "pending" ? <>
      <p className={s.hint}>Позвоните с {formatPhoneDisplay(phone)} на проверочный номер. Разговаривать и вводить код не нужно.</p>
      <p className={s.hint} role="status">Ждём звонок. После проверки страница обновится автоматически. Если у вас две SIM-карты, выберите SIM с указанным номером.</p>
      {attempt.call_phone && <a className={`${s.primary} ${layout.callNumber}`} href={`tel:${attempt.call_phone}`}>Позвонить: {formatPhoneDisplay(attempt.call_phone)}</a>}
    </> : <>
      {attempt && <p className={s.hint}>{attempt.state === "expired" ? "Время проверки истекло. Начните заново." : "Номер не подтверждён. Повторите проверку."}</p>}
      <button type="button" className={s.secondary} disabled={busy || disabled} onClick={() => void start()}>
        {busy ? (telegram ? "Отправляем код…" : "Подготавливаем проверку…") : label}
      </button>
    </>}
    {error && <p className={s.statusErr} role="alert">{error}</p>}
  </div>;
}

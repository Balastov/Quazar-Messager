import { useEffect, useRef, useState } from "react";
import { phoneVerificationApi, type PhoneVerification as Attempt, type PhoneMode } from "../../api/phoneVerification";
import { useAuthStore } from "../../store/auth";
import { apiErrorText } from "../../utils/profile";
import { formatRuPhoneDisplay } from "../../utils/phone";
import s from "../SettingsView.module.css";

export default function PhoneVerification({ phone, account = false, proof, onVerified, buttonLabel = "Подтвердить телефон звонком", disabled = false }: {
  phone: string; account?: PhoneMode; proof?: string; onVerified: (token: string) => void; buttonLabel?: string; disabled?: boolean;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
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
    round.current++; setAttempt(null); setBusy(false); setError(null);
    try {
      const saved = account === "reauth" ? null : JSON.parse(sessionStorage.getItem(`quazar-phone-check:${account}:${phone}`) ?? "null");
      if (saved?.phone === phone && saved.verification_token && Date.parse(saved.expires_at) > Date.now()) {
        setAttempt({ ...saved, state: "pending" });
      }
    } catch { /* Проверка работает и без хранилища браузера. */ }
    return () => { round.current++; };
  }, [phone, account]);
  useEffect(() => {
    if (!attempt?.verification_token || attempt.state !== "pending") return;
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
  }, [attempt?.verification_token, attempt?.state, account]);
  const start = async () => {
    if (busy || disabled) return;
    const current = ++round.current;
    setBusy(true); setError(null); setAttempt(null);
    try {
      const result = await phoneVerificationApi.start(phone, account);
      if (current === round.current) {
        setAttempt(result);
        try { sessionStorage.setItem(`quazar-phone-check:${account}:${phone}`, JSON.stringify(result)); } catch { /* optional */ }
      }
    } catch (err) {
      if (current === round.current) setError(apiErrorText(err, "Не удалось начать проверку"));
    } finally { if (current === round.current) setBusy(false); }
  };
  if (proof || attempt?.state === "verified") return <p className={s.statusOk} role="status">✓ {account === "reauth" ? "Действие подтверждено" : "Телефон подтверждён"}</p>;
  return <div role="group" aria-label="Подтверждение телефона">
    {attempt?.state === "pending" ? <>
      <p className={s.hint}>Позвоните с {formatRuPhoneDisplay(phone)} на проверочный номер. Разговаривать и вводить код не нужно.</p>
      {attempt.call_phone && <p><a className={s.primary} href={`tel:${attempt.call_phone}`}>Позвонить: {formatRuPhoneDisplay(attempt.call_phone)}</a></p>}
      <p className={s.hint} role="status">Ждём звонок. После проверки страница обновится автоматически. Если у вас две SIM-карты, выберите SIM с указанным номером.</p>
    </> : <>
      {attempt && <p className={s.hint}>{attempt.state === "expired" ? "Время проверки истекло. Начните заново." : "Номер не подтверждён. Повторите проверку."}</p>}
      <button type="button" className={s.secondary} disabled={busy || disabled} onClick={() => void start()}>
        {busy ? "Подготавливаем проверку…" : buttonLabel}
      </button>
    </>}
    {error && <p className={s.statusErr} role="alert">{error}</p>}
  </div>;
}

import { useEffect, useState } from "react";
import { useAuthStore } from "../../store/auth";
import { phoneVerificationApi } from "../../api/phoneVerification";
import ChatDialog from "../chat/ChatDialog";
import PhoneVerification from "./PhoneVerification";
import s from "../SettingsView.module.css";

export default function PhoneVerificationPrompt() {
  const user = useAuthStore(st => st.user);
  const authDue = useAuthStore(st => st.phonePromptPending);
  const dismiss = useAuthStore(st => st.dismissPhonePrompt);
  const [weeklyDue, setWeeklyDue] = useState(false);
  const [proof, setProof] = useState<string>();
  useEffect(() => {
    setWeeklyDue(false); setProof(undefined);
    if (!user || user.phone_verified_at) return;
    let active = true, inFlight = false, timer: ReturnType<typeof setTimeout>;
    let loginPromptUnclaimed = useAuthStore.getState().phonePromptPending;
    const check = () => {
      if (!active || inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      const alreadyShownOnLogin = loginPromptUnclaimed || useAuthStore.getState().phonePromptPending;
      void phoneVerificationApi.reminder().then(result => {
        if (!active) return;
        loginPromptUnclaimed = false;
        if (result.due && !alreadyShownOnLogin) setWeeklyDue(true);
        timer = setTimeout(check, Math.max(1000, Date.parse(result.next_at) - Date.parse(result.server_time) + 1000));
      }).catch(() => { if (active) timer = setTimeout(check, 60_000); }).finally(() => { inFlight = false; });
    };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    check(); document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [user?.id, user?.phone_verified_at]);
  if (!user || user.phone_verified_at || user.phone_discoverable === null || (!authDue && !weeklyDue)) return null;
  const close = () => { dismiss(); setWeeklyDue(false); };
  return <ChatDialog title="Подтвердите телефон" onClose={close}>
    <p className={s.hint}>Подтвердите, что номер принадлежит вам. Это поможет защитить аккаунт и позволит входить без пароля.</p>
    <PhoneVerification phone={user.phone!} account proof={proof} onVerified={setProof} />
    <button type="button" className={s.secondary} onClick={close}>Напомнить позже</button>
  </ChatDialog>;
}

import { useEffect, useState } from "react";
import { authApi } from "../../api/auth";
import { usersApi } from "../../api/users";
import { useAuthStore } from "../../store/auth";
import PhoneVerification from "./PhoneVerification";
import s from "../SettingsView.module.css";

export default function PhoneVerificationSetting() {
  const user = useAuthStore(st => st.user);
  const [enabled, setEnabled] = useState(false);
  const [proof, setProof] = useState<string>();
  useEffect(() => { void authApi.providers().then(p => setEnabled(!!p.phone_verification)).catch(() => {}); }, []);
  if (!user || !enabled) return null;
  return <>
    <h3 className={s.sectionTitle}>Подтверждение телефона</h3>
    {user.phone_verified_at ? <p className={s.statusOk}>✓ Телефон подтверждён</p> : <PhoneVerification
      phone={user.phone!} account proof={proof} onVerified={(token) => {
        setProof(token);
        void usersApi.me().then(me => useAuthStore.getState().setUser(me)).catch(() => {});
      }} />}
  </>;
}

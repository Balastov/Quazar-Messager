import { useState } from "react";
import LogoutDialog from "./LogoutDialog";
import PhoneVerificationSetting from "../profile/PhoneVerificationSetting";
import SignInSettings from "../profile/SignInSettings";
import { IconLogout } from "../icons";
import s from "../SettingsView.module.css";

export default function AccountSection() {
  const [leaving, setLeaving] = useState(false);
  return (
    <>
      <section className={s.card}>
        <PhoneVerificationSetting />
      </section>
      <section className={s.card}>
        <SignInSettings />
      </section>
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Выход</h3>
        <p className={s.hint}>
          Ключи шифрования обычно остаются на этом устройстве. На чужом компьютере при выходе
          отметьте «Удалить ключи шифрования и черновики». Завершить сеансы на других устройствах —
          в разделе «Безопасность».
        </p>
        <div className={s.rowBtns}>
          <button type="button" className={s.secondary} onClick={() => setLeaving(true)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <IconLogout size={16} /> Выйти
            </span>
          </button>
        </div>
      </section>
      {leaving && <LogoutDialog onClose={() => setLeaving(false)} />}
    </>
  );
}

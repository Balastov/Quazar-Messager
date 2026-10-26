import { useState } from "react";
import { usersApi } from "../../api/users";
import type { User } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import { apiErrorText } from "../../utils/profile";
import PhoneVisibilityChoice from "./PhoneVisibilityChoice";
import base from "../SettingsView.module.css";

/** Настройка в профиле: меняется сразу, без кнопки «Сохранить». */
export default function PhoneVisibilitySetting({ user }: { user: User }) {
  const setUser = useAuthStore((st) => st.setUser);
  // Пока сервер не ответил — показываем новый выбор, при ошибке откатываем.
  const [pending, setPending] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = async (value: boolean) => {
    if (value === user.phone_discoverable || pending !== null) return;
    setPending(value);
    setStatus(null);
    setError(null);
    try {
      setUser(await usersApi.updateMe({ phone_discoverable: value }));
      setStatus(value ? "По номеру вас теперь можно найти" : "Номер скрыт");
    } catch (err) {
      setError(apiErrorText(err, "Не удалось сохранить"));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <PhoneVisibilityChoice
        value={pending ?? user.phone_discoverable ?? null}
        onChange={(v) => void change(v)}
        disabled={pending !== null}
      />
      {status && <div className={base.statusOk}>{status}</div>}
      {error && <div className={base.statusErr}>{error}</div>}
    </>
  );
}

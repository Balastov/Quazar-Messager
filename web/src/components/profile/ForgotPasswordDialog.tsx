import { useState } from "react";
import { authApi } from "../../api/auth";
import { apiErrorText } from "../../utils/profile";
import ChatDialog from "../chat/ChatDialog";
import s from "../SettingsView.module.css";

export default function ForgotPasswordDialog({ initialLogin = "", onClose }: { initialLogin?: string; onClose: () => void }) {
  const [login, setLogin] = useState(initialLogin);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <ChatDialog title="Забыл пароль" onClose={onClose}>
    {message ? <>
      <p className={s.hint} role="status">{message}</p>
      <button type="button" className={s.secondary} onClick={onClose}>Вернуться ко входу</button>
    </> : <form onSubmit={(event) => {
      event.preventDefault(); if (busy || !login.trim()) return;
      setBusy(true); setError(null);
      void authApi.forgotPassword(login.trim()).then((result) => setMessage(result.message))
        .catch((err) => setError(apiErrorText(err, "Не удалось отправить запрос"))).finally(() => setBusy(false));
    }}>
      <p className={s.hint}>Укажите никнейм или номер телефона аккаунта. Администратор получит запрос на восстановление доступа.</p>
      <label>Логин
        <input className={s.input} value={login} onChange={(e) => setLogin(e.target.value)} maxLength={128}
          placeholder="Никнейм или номер телефона" aria-label="Логин для восстановления" autoComplete="username"
          autoFocus required disabled={busy} />
      </label>
      {error && <p className={s.statusErr} role="alert">{error}</p>}
      <div className={s.rowBtns} style={{ marginTop: 12 }}>
        <button type="submit" className={s.primary} disabled={busy || !login.trim()}>{busy ? "Отправляем…" : "Отправить запрос"}</button>
        <button type="button" className={s.secondary} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </form>}
  </ChatDialog>;
}

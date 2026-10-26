import { useState } from "react";
import { createPortal } from "react-dom";
import { usersApi } from "../../api/users";
import { useAuthStore } from "../../store/auth";
import { apiErrorText } from "../../utils/profile";
import PhoneVisibilityChoice, { PHONE_VISIBILITY_QUESTION } from "./PhoneVisibilityChoice";
import s from "./PhoneVisibilityGate.module.css";

/** Аккаунты до появления настройки: при входе спрашиваем один раз. Закрыть без выбора нельзя. */
export default function PhoneVisibilityGate() {
  const user = useAuthStore((st) => st.user);
  const setUser = useAuthStore((st) => st.setUser);
  const [value, setValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Строго null — ответ сервера «ещё не выбирал»; undefined — профиль ещё не перечитан.
  if (!user || user.phone_discoverable !== null) return null;

  const save = async () => {
    if (value === null) return;
    setBusy(true);
    setError(null);
    try {
      setUser(await usersApi.updateMe({ phone_discoverable: value }));
    } catch (err) {
      setError(apiErrorText(err, "Не удалось сохранить — попробуйте ещё раз"));
    } finally {
      setBusy(false);
    }
  };

  // В body: панели со стеклом (backdrop-filter) запирают z-index внутри себя.
  return createPortal(
    <div className={s.overlay}>
      <div className={s.panel} role="dialog" aria-modal="true" aria-labelledby="phone-visibility-title">
        <h2 id="phone-visibility-title" className={s.title}>
          {PHONE_VISIBILITY_QUESTION}
        </h2>
        <p className={s.lead}>
          Мы добавили настройку приватности номера. Выберите вариант — изменить его можно в любой
          момент в настройках профиля.
        </p>
        <PhoneVisibilityChoice value={value} onChange={setValue} disabled={busy} showQuestion={false} />
        {error && <p className={s.error}>{error}</p>}
        <button type="button" className={s.save} disabled={value === null || busy} onClick={() => void save()}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </div>,
    document.body
  );
}

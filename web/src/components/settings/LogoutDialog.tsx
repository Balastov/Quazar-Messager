import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { devicesApi } from "../../api/devices";
import { logoutAndForgetDevice } from "../../auth/forgetDevice";
import { useAuthStore } from "../../store/auth";
import { useE2EStore } from "../../store/e2e";
import Dialog from "../constellation/Dialog";
import { logError } from "../../utils/log";
import s from "../SettingsView.module.css";

/** Ключ аккаунта есть только здесь: ни копии, ни другого устройства с ключом. */
function useOnlyCopyHere(): boolean {
  const ready = useE2EStore((st) => st.status === "ready");
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const [otherHasKey, setOtherHasKey] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ready || hasServerBackup) return;
    let active = true;
    devicesApi
      .list()
      .then((all) => active && setOtherHasKey(all.some((device) => !device.current && device.has_account_key === true)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [ready, hasServerBackup]);
  return ready && !hasServerBackup && otherHasKey === false;
}

/** Выход из аккаунта; на чужом компьютере можно сразу стереть ключи переписки. */
export default function LogoutDialog({ onClose }: { onClose(): void }) {
  const userId = useAuthStore((st) => st.user?.id);
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onlyHere = useOnlyCopyHere();

  const leave = async () => {
    if (!forget || !userId) {
      useAuthStore.getState().logout();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await logoutAndForgetDevice(userId);
    } catch (err) {
      logError("forget device keys", err);
      setError("Не удалось стереть ключи — вы остались в аккаунте. Попробуйте ещё раз.");
      setBusy(false);
    }
  };

  return createPortal(
    <Dialog title="Выйти из аккаунта" onClose={onClose}>
      <p className={s.hint}>
        Обычно ключи шифрования остаются на устройстве: если снова войти здесь, переписка
        откроется сразу.
      </p>
      <label className={s.toggle}>
        <input type="checkbox" checked={forget} disabled={busy} onChange={(e) => setForget(e.target.checked)} />
        <span className={s.toggleUi} />
        <span className={s.toggleLabel}>Удалить ключи шифрования и черновики с этого устройства</span>
      </label>
      <p className={s.hint}>
        Для чужого или общего компьютера: после этого никто здесь не сможет прочитать вашу
        переписку. Чтобы снова читать её на этом устройстве, ключ придётся получить заново.
      </p>
      {forget && onlyHere && (
        <p className={s.statusErr} role="alert">
          Ключ есть только на этом устройстве, а резервной копии нет. Если удалить его, старую
          переписку будет не прочитать нигде. Сначала сохраните копию («Безопасность → Резервная
          копия ключа») или передайте ключ на другое своё устройство.
        </p>
      )}
      {error && <p className={s.statusErr} role="alert">{error}</p>}
      <div className={s.rowBtns}>
        <button type="button" className={forget ? s.danger : s.primary} disabled={busy} onClick={() => void leave()}>
          {busy ? "Удаляем…" : forget ? "Удалить ключи и выйти" : "Выйти"}
        </button>
        <button type="button" className={s.secondary} disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </Dialog>,
    document.body
  );
}

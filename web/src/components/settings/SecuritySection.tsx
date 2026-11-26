import { useState } from "react";
import { clearReauth } from "../../auth/reauth";
import { downloadBackupFile, BackupError } from "../../crypto/backup";
import { fetchKeyBackup, shortKeyId, type AccountProof } from "../../crypto/keys";
import { useAuthStore } from "../../store/auth";
import { useE2EStore } from "../../store/e2e";
import DeviceSessions from "../devices/DeviceSessions";
import AccountProofInput from "../profile/AccountProofInput";
import { KeyHelpButton } from "./KeyWarning";
import { useSettingsRun } from "./useSettingsRun";
import s from "../SettingsView.module.css";

export default function SecuritySection() {
  const user = useAuthStore((st) => st.user);
  const e2eStatus = useE2EStore((st) => st.status);
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const e2eError = useE2EStore((st) => st.error);
  const accountPublicKey = useE2EStore((st) => st.accountPublicKey);
  const localPublicKey = useE2EStore((st) => st.localPublicKey);
  const [backupPassword, setBackupPassword] = useState("");
  const [rotateProof, setRotateProof] = useState<AccountProof | null>(null);
  // Подтверждение одноразовое: после смены ключей поле подтверждения начинается заново.
  const [proofRound, setProofRound] = useState(0);
  const { busy, run, setStatus, feedback } = useSettingsRun();
  if (!user) return null;
  const ready = e2eStatus === "ready";

  return (
    <>
      <section className={s.card} aria-label="Шифрование переписки" data-tour="security-e2e">
        <h3 className={s.sectionTitle}>Шифрование переписки</h3>
        <p className={s.hint}>
          Личные сообщения шифруются прямо на ваших устройствах — прочитать их можете только вы и
          собеседник.
        </p>
        {ready && <p className={s.statusOk}>✓ Переписка на этом устройстве читается.</p>}
        {e2eStatus === "needs_restore" && (
          <p className={s.statusErr}>Личные сообщения на этом устройстве пока не читаются.</p>
        )}
        {(e2eStatus === "checking" || e2eStatus === "idle") && <p className={s.hint}>Проверяем…</p>}
        {e2eStatus === "error" && (
          <p className={s.statusErr}>{e2eError ?? "Не удалось проверить ключи шифрования"}</p>
        )}
        <div className={s.rowBtns}>
          {e2eStatus === "needs_restore" && (
            <button
              type="button"
              className={s.primary}
              onClick={() => useE2EStore.getState().setRestorePromptOpen(true)}
            >
              Открыть переписку
            </button>
          )}
          {e2eStatus === "error" && (
            <button type="button" className={s.secondary} onClick={() => void useE2EStore.getState().sync(user.id)}>
              Проверить снова
            </button>
          )}
        </div>
      </section>

      {ready && (
        <section className={s.card} aria-label="Восстановление переписки" data-tour="security-backup">
          <h3 className={s.sectionTitle}>Восстановление переписки</h3>
          <p className={s.hint}>
            Необязательно. Без пароля переписку на новом устройстве откроет другое ваше устройство, а если
            доступа к ним нет — проверка номера: новые сообщения будут читаться, но старые личные не
            вернутся. С паролем для восстановления вернутся и старые.
          </p>
          {hasServerBackup ? (
            <p className={s.statusOk}>✓ Пароль задан.</p>
          ) : (
            <p className={s.hint}>Пароль не задан.</p>
          )}
          <input
            className={s.input}
            type="password"
            placeholder={hasServerBackup ? "Новый пароль для восстановления" : "Пароль для восстановления"}
            aria-label="Пароль для восстановления"
            value={backupPassword}
            onChange={(e) => setBackupPassword(e.target.value)}
            disabled={busy}
            autoComplete="new-password"
          />
          <p className={s.hint}>
            Не меньше 8 символов. Придумайте отдельный пароль, не от аккаунта, и запишите его:
            восстановить его нельзя — его не знаем даже мы.
          </p>
          <div className={s.rowBtns}>
            <button
              type="button"
              className={s.primary}
              disabled={busy || backupPassword.length < 8}
              onClick={() =>
                void run(async () => {
                  await useE2EStore.getState().createBackup(backupPassword);
                  setBackupPassword("");
                  setStatus("Пароль для восстановления сохранён");
                })
              }
            >
              {hasServerBackup ? "Сменить пароль" : "Задать пароль"}
            </button>
            {hasServerBackup && (
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const blob = await fetchKeyBackup();
                    if (!blob) throw new BackupError("На сервере нет копии");
                    downloadBackupFile(blob, user.username);
                    setStatus("Файл сохранён. Откроется тем же паролем для восстановления");
                  })
                }
              >
                Сохранить в файл
              </button>
            )}
          </div>
        </section>
      )}

      <DeviceSessions />

      <section className={s.card} data-tour="security-more">
        <details className={s.details}>
          <summary>Подробнее о ключах шифрования</summary>
          <p className={s.hint}>
            Ключ аккаунта: <code>{shortKeyId(accountPublicKey)}</code>
            {localPublicKey && localPublicKey !== accountPublicKey && (
              <> · ключ этого устройства: <code>{shortKeyId(localPublicKey)}</code></>
            )}
          </p>
          <div className={s.rowBtns}>
            <KeyHelpButton label="Как это работает" />
          </div>
          {ready && (
            <details className={s.details}>
              <summary>Сменить ключи шифрования</summary>
              <p className={s.hint}>
                Нужно, только если ключ мог попасть к чужим людям — например, потерян телефон без
                блокировки. Старая переписка останется читаемой на устройствах, где есть прежний
                ключ; на остальных переписку нужно будет открыть заново, а собеседники увидят, что
                ключ сменился.
              </p>
              <AccountProofInput
                key={proofRound}
                purpose="settings"
                onChange={setRotateProof}
                disabled={busy}
                inputClassName={s.input}
                buttonClassName={s.secondary}
                hintClassName={s.hint}
                placeholder="Пароль аккаунта для смены ключей"
              />
              <button
                type="button"
                className={s.danger}
                disabled={busy || !rotateProof}
                onClick={() =>
                  void run(async () => {
                    await useE2EStore.getState().rotate(rotateProof!);
                    clearReauth();
                    setRotateProof(null);
                    setProofRound((n) => n + 1);
                    setStatus(
                      "Ключи обновлены. Задайте пароль для восстановления заново. На остальных устройствах переписку нужно будет открыть заново."
                    );
                  })
                }
              >
                Сменить ключи
              </button>
            </details>
          )}
        </details>
      </section>
      {feedback}
    </>
  );
}

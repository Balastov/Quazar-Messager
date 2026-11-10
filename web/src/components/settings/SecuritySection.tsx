import { useState } from "react";
import { clearReauth } from "../../auth/reauth";
import { downloadBackupFile, BackupError } from "../../crypto/backup";
import { fetchKeyBackup, type AccountProof } from "../../crypto/keys";
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
  const [backupPassword, setBackupPassword] = useState("");
  const [rotateProof, setRotateProof] = useState<AccountProof | null>(null);
  // Подтверждение одноразовое: после смены ключей поле подтверждения начинается заново.
  const [proofRound, setProofRound] = useState(0);
  const { busy, run, setStatus, feedback } = useSettingsRun();
  if (!user) return null;
  const ready = e2eStatus === "ready";

  return (
    <>
      <section className={s.card} aria-label="Ключи шифрования">
        <h3 className={s.sectionTitle}>Ключи шифрования</h3>
        <p className={s.hint}>
          Личные сообщения шифруются ключом вашего аккаунта. Он хранится только на ваших
          устройствах — поэтому переписку не прочитает никто, кроме вас и собеседника.
        </p>
        {ready && (
          <p className={s.statusOk}>
            ✓ На этом устройстве ключ есть — личные сообщения читаются.
            {hasServerBackup ? " Резервная копия сохранена." : " Резервной копии пока нет."}
          </p>
        )}
        {e2eStatus === "needs_restore" && (
          <p className={s.statusErr}>На этом устройстве ключа нет — личные сообщения здесь не открываются.</p>
        )}
        {(e2eStatus === "checking" || e2eStatus === "idle") && <p className={s.hint}>Проверяем ключи…</p>}
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
              Восстановить ключи
            </button>
          )}
          {e2eStatus === "error" && (
            <button type="button" className={s.secondary} onClick={() => void useE2EStore.getState().sync(user.id)}>
              Проверить снова
            </button>
          )}
          <KeyHelpButton label={e2eStatus === "needs_restore" ? "Что с этим делать?" : "Как это работает"} />
        </div>
      </section>

      {ready && (
        <section className={s.card} aria-label="Резервная копия">
          <h3 className={s.sectionTitle}>Резервная копия ключа</h3>
          <p className={s.hint}>
            Нужна, если потеряете все свои устройства. Копия шифруется вашим паролем — сервер
            хранит только зашифрованный файл и пароля не знает.
            {!hasServerBackup && " Рекомендуем создать копию."}
          </p>
          <input
            className={s.input}
            type="password"
            placeholder="Новый пароль для копии (≥8)"
            value={backupPassword}
            onChange={(e) => setBackupPassword(e.target.value)}
            disabled={busy}
            autoComplete="new-password"
          />
          <p className={s.hint}>
            Придумайте отдельный пароль (не от аккаунта) и сохраните его: без него копию не
            открыть, а восстановить его нельзя. Новая копия заменяет прежнюю.
          </p>
          <div className={s.rowBtns}>
            <button
              type="button"
              className={s.primary}
              disabled={busy || backupPassword.length < 8}
              onClick={() =>
                void run(async () => {
                  const blob = await useE2EStore.getState().createBackup(backupPassword);
                  downloadBackupFile(blob, user.username);
                  setBackupPassword("");
                  setStatus("Резервная копия сохранена и скачана");
                })
              }
            >
              Сохранить и скачать
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
                    setStatus("Файл скачан");
                  })
                }
              >
                Скачать копию с сервера
              </button>
            )}
          </div>
        </section>
      )}

      <DeviceSessions />

      {ready && (
        <section className={s.card}>
          <details className={s.details}>
            <summary>Сменить ключи шифрования</summary>
            <p className={s.hint}>
              Нужно, только если ключ мог попасть к чужим людям — например, потерян телефон без
              блокировки. Старая переписка останется читаемой на устройствах, где есть прежний
              ключ; на остальных устройствах ключ придётся получить заново, а собеседники увидят,
              что ключ сменился.
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
                    "Ключи обновлены. Создайте новую резервную копию. На остальных устройствах получите новый ключ с этого устройства или из новой копии."
                  );
                })
              }
            >
              Сменить ключи
            </button>
          </details>
        </section>
      )}
      {feedback}
    </>
  );
}

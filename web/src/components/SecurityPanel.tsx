import { useRef, useState } from "react";
import { useAuthStore } from "../store/auth";
import {
  createBackupBlob,
  downloadBackupFile,
  readBackupFile,
  restoreFromBackupBlob,
  BackupError,
} from "../crypto/backup";
import {
  fetchKeyBackup,
  hasBackupDone,
  markBackupDone,
  rotateKeysOnServer,
  rotateLocalKeys,
  uploadKeyBackup,
  uploadPublicKey,
} from "../crypto/keys";
import s from "./SecurityPanel.module.css";

interface Props {
  onClose: () => void;
}

export default function SecurityPanel({ onClose }: Props) {
  const user = useAuthStore((st) => st.user);
  const [backupPassword, setBackupPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [rotatePassword, setRotatePassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBackup = () =>
    run(async () => {
      const blob = await createBackupBlob(backupPassword);
      await uploadKeyBackup(blob);
      downloadBackupFile(blob, user?.username ?? "user");
      markBackupDone();
      setBackupPassword("");
      setStatus("Резервная копия сохранена на сервере и скачана как файл.");
    });

  const handleDownloadServerBackup = () =>
    run(async () => {
      const blob = await fetchKeyBackup();
      if (!blob) {
        throw new BackupError("На сервере нет резервной копии");
      }
      downloadBackupFile(blob, user?.username ?? "user");
      setStatus("Файл резервной копии скачан.");
    });

  const handleRestoreFile = (file: File) =>
    run(async () => {
      const blob = await readBackupFile(file);
      const { publicKey } = await restoreFromBackupBlob(blob, restorePassword);
      await uploadPublicKey(publicKey, true);
      markBackupDone();
      setRestorePassword("");
      setStatus(
        "Ключи восстановлены. Собеседникам может потребоваться подтвердить новый/восстановленный ключ."
      );
    });

  const handleRestoreFromServer = () =>
    run(async () => {
      const blob = await fetchKeyBackup();
      if (!blob) {
        throw new BackupError("На сервере нет резервной копии");
      }
      const { publicKey } = await restoreFromBackupBlob(blob, restorePassword);
      await uploadPublicKey(publicKey, true);
      markBackupDone();
      setRestorePassword("");
      setStatus("Ключи восстановлены из серверной копии.");
    });

  const handleRotate = () =>
    run(async () => {
      const keys = await rotateLocalKeys();
      await rotateKeysOnServer(rotatePassword, keys.publicKey);
      setRotatePassword("");
      setStatus(
        "Ключи обновлены. Старые сообщения могут не расшифроваться. Создайте новую резервную копию."
      );
    });

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <h3 className={s.title}>Безопасность E2E</h3>
          <button type="button" className={s.close} onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <p className={s.lead}>
          Резервная копия шифруется вашим паролем. Сервер хранит только ciphertext и не может
          прочитать ключи.
          {!hasBackupDone() && (
            <span className={s.warn}> Рекомендуется создать копию сейчас.</span>
          )}
        </p>

        <section className={s.section}>
          <h4 className={s.sectionTitle}>Создать резервную копию</h4>
          <input
            className={s.input}
            type="password"
            placeholder="Пароль для копии (≥8)"
            value={backupPassword}
            onChange={(e) => setBackupPassword(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className={s.primary}
            disabled={busy || backupPassword.length < 8}
            onClick={() => void handleCreateBackup()}
          >
            Сохранить и скачать
          </button>
          <button
            type="button"
            className={s.secondary}
            disabled={busy}
            onClick={() => void handleDownloadServerBackup()}
          >
            Скачать копию с сервера
          </button>
        </section>

        <section className={s.section}>
          <h4 className={s.sectionTitle}>Восстановить ключи</h4>
          <input
            className={s.input}
            type="password"
            placeholder="Пароль резервной копии"
            value={restorePassword}
            onChange={(e) => setRestorePassword(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className={s.secondary}
            disabled={busy || restorePassword.length < 8}
            onClick={() => void handleRestoreFromServer()}
          >
            Восстановить с сервера
          </button>
          <button
            type="button"
            className={s.secondary}
            disabled={busy || restorePassword.length < 8}
            onClick={() => fileRef.current?.click()}
          >
            Восстановить из файла
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".quazar-key,application/octet-stream"
            className={s.hidden}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleRestoreFile(file);
              e.target.value = "";
            }}
          />
        </section>

        <section className={s.section}>
          <h4 className={s.sectionTitle}>Ротация ключей</h4>
          <p className={s.hint}>
            Создаёт новую пару ключей. Подтвердите паролем аккаунта. Собеседники увидят
            предупреждение о смене ключа.
          </p>
          <input
            className={s.input}
            type="password"
            placeholder="Пароль аккаунта"
            value={rotatePassword}
            onChange={(e) => setRotatePassword(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className={s.danger}
            disabled={busy || rotatePassword.length < 8}
            onClick={() => void handleRotate()}
          >
            Сменить ключи
          </button>
        </section>

        {status && <div className={s.statusOk}>{status}</div>}
        {error && <div className={s.statusErr}>{error}</div>}
      </div>
    </div>
  );
}

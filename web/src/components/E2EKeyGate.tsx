import { useRef, useState } from "react";
import axios from "axios";
import { shortKeyId, StaleBackupError } from "../crypto/keys";
import { useE2EStore } from "../store/e2e";
import { useUiStore } from "../store/ui";
import s from "./E2EKeyGate.module.css";
import AccountProofInput from "./profile/AccountProofInput";
import { clearReauth } from "../auth/reauth";
import type { AccountProof } from "../crypto/keys";

const BACKUP_HINT_DISMISSED_KEY = "quazar_e2e_backup_hint_dismissed";

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (err.response?.status === 401 && detail === "Invalid password") {
      return "Неверный пароль аккаунта";
    }
    if (err.response?.status === 401) return "Сессия истекла — войдите в аккаунт заново";
    if (typeof detail === "string") return detail;
  }
  return err instanceof Error ? err.message : "Ошибка";
}

function readHintDismissed(): boolean {
  try {
    return localStorage.getItem(BACKUP_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface StaleBackup {
  blob: string;
  backupPassword: string;
  backupPublicKey: string;
  accountPublicKey: string;
}

/**
 * Следит, чтобы устройство работало с ключом аккаунта:
 * предлагает восстановить ключи из копии или создать копию для других устройств.
 */
export default function E2EKeyGate() {
  const status = useE2EStore((st) => st.status);
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const hasLocalKey = useE2EStore((st) => st.hasLocalKey);
  const accountPublicKey = useE2EStore((st) => st.accountPublicKey);
  const localPublicKey = useE2EStore((st) => st.localPublicKey);
  const restorePromptOpen = useE2EStore((st) => st.restorePromptOpen);
  const setRestorePromptOpen = useE2EStore((st) => st.setRestorePromptOpen);
  const busy = useE2EStore((st) => st.busy);

  const [password, setPassword] = useState("");
  // Пароль аккаунта или подтверждение через Яндекс (аккаунт без пароля).
  const [rotateProof, setRotateProof] = useState<AccountProof | null>(null);
  const [adoptProof, setAdoptProof] = useState<AccountProof | null>(null);
  // Подтверждение одноразовое: после попытки поля подтверждения начинаются заново.
  const [proofRound, setProofRound] = useState(0);
  const [stale, setStale] = useState<StaleBackup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hintDismissed, setHintDismissed] = useState(readHintDismissed);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      setPassword("");
      setStale(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  /** Восстановление: копия с другим ключом — не ошибка-тупик, а предложение. */
  const runRestore = async (fn: () => Promise<void>) => {
    setStale(null);
    setError(null);
    try {
      await fn();
      setPassword("");
    } catch (err) {
      if (err instanceof StaleBackupError) {
        setStale({
          blob: err.blob,
          backupPassword: password,
          backupPublicKey: err.backupPublicKey,
          accountPublicKey: err.accountPublicKey,
        });
        return;
      }
      setError(errorMessage(err));
    }
  };

  if (status === "needs_restore" && restorePromptOpen) {
    const { restoreFromServer, restoreFromFile, rotate, adoptBackup, sync, userId } =
      useE2EStore.getState();
    return (
      <div className={s.overlay}>
        <div className={s.panel} role="dialog" aria-modal="true">
          <div className={s.header}>
            <h3 className={s.title}>Восстановите ключи шифрования</h3>
          </div>

          <p className={s.lead}>
            У вашего аккаунта уже есть ключ шифрования с другого устройства. Чтобы читать и
            отправлять личные сообщения здесь, восстановите его из резервной копии.
            {hasLocalKey && (
              <span className={s.warn}>
                {" "}
                Прежний ключ этого браузера сохранится — им по-прежнему расшифруется старая
                переписка.
              </span>
            )}
          </p>
          <p className={s.hint}>
            Ключ аккаунта: <code>{shortKeyId(accountPublicKey)}</code> · ключ этого браузера:{" "}
            <code>{shortKeyId(localPublicKey)}</code>
          </p>

          <section className={s.section}>
            {!hasServerBackup && (
              <p className={s.hint}>
                На сервере нет резервной копии. Откройте Quazar на устройстве, где сообщения
                читаются, и создайте копию: Настройки → Безопасность E2E. Затем нажмите
                «Проверить снова» — или восстановите ключи из файла копии.
              </p>
            )}
            <input
              className={s.input}
              type="password"
              placeholder="Пароль резервной копии"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <div className={s.actions}>
              {hasServerBackup ? (
                <button
                  type="button"
                  className={s.primary}
                  disabled={busy || password.length < 8}
                  onClick={() => void runRestore(() => restoreFromServer(password))}
                >
                  {busy ? "Восстанавливаем…" : "Восстановить"}
                </button>
              ) : (
                <button
                  type="button"
                  className={s.secondary}
                  disabled={busy || !userId}
                  onClick={() => userId && void run(() => sync(userId))}
                >
                  Проверить снова
                </button>
              )}
              <button
                type="button"
                className={s.secondary}
                disabled={busy || password.length < 8}
                onClick={() => fileRef.current?.click()}
              >
                Из файла
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".quazar-key,application/octet-stream"
              className={s.hidden}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void runRestore(() => restoreFromFile(file, password));
              }}
            />
          </section>

          {stale && (
            <section className={s.section}>
              <h4 className={s.sectionTitle}>Копия от другого ключа</h4>
              <p className={s.hint}>
                Пароль подошёл, но в копии ключ <code>{shortKeyId(stale.backupPublicKey)}</code>,
                а у аккаунта сейчас <code>{shortKeyId(stale.accountPublicKey)}</code> — его
                создало другое устройство (например, браузер на телефоне).
              </p>
              <p className={s.hint}>
                Можно сделать ключ из копии ключом аккаунта: вернётся переписка, зашифрованная
                этим ключом. Сообщения, зашифрованные ключом{" "}
                <code>{shortKeyId(stale.accountPublicKey)}</code>, останутся читаемыми только на
                том устройстве; на остальных ключи нужно будет восстановить из этой копии.
              </p>
              <AccountProofInput
                key={`adopt-${proofRound}`}
                purpose="app"
                onChange={setAdoptProof}
                disabled={busy}
                inputClassName={s.input}
                buttonClassName={s.primary}
                hintClassName={s.hint}
              />
              <button
                type="button"
                className={s.primary}
                disabled={busy || !adoptProof}
                onClick={() =>
                  void run(async () => {
                    try {
                      await adoptBackup(stale.blob, stale.backupPassword, adoptProof!);
                    } finally {
                      clearReauth();
                      setAdoptProof(null);
                      setProofRound((n) => n + 1);
                    }
                  })
                }
              >
                {busy ? "Сохраняем…" : "Сделать ключом аккаунта"}
              </button>
            </section>
          )}

          <section className={s.section}>
            <h4 className={s.sectionTitle}>Нет ни копии, ни доступа к другим устройствам?</h4>
            <p className={s.hint}>
              Можно создать новые ключи аккаунта. Переписка, зашифрованная старым ключом, здесь
              не прочитается, а на остальных устройствах ключи придётся восстановить заново.
              Собеседники увидят предупреждение о смене ключа.
            </p>
            <AccountProofInput
              key={`rotate-${proofRound}`}
              purpose="app"
              onChange={setRotateProof}
              disabled={busy}
              inputClassName={s.input}
              buttonClassName={s.primary}
              hintClassName={s.hint}
            />
            <button
              type="button"
              className={s.danger}
              disabled={busy || !rotateProof}
              onClick={() =>
                void run(async () => {
                  try {
                    await rotate(rotateProof!);
                  } finally {
                    clearReauth();
                    setRotateProof(null);
                    setProofRound((n) => n + 1);
                  }
                })
              }
            >
              Создать новые ключи
            </button>
          </section>

          {error && <div className={s.statusErr}>{error}</div>}

          <button
            type="button"
            className={s.later}
            disabled={busy}
            onClick={() => setRestorePromptOpen(false)}
          >
            Позже
          </button>
        </div>
      </div>
    );
  }

  if (status === "needs_restore") {
    return (
      <div className={`${s.banner} ${s.bannerWarn}`}>
        <span className={s.bannerText}>
          Ключи шифрования не восстановлены — личные сообщения на этом устройстве недоступны.
        </span>
        <button
          type="button"
          className={s.bannerAction}
          onClick={() => setRestorePromptOpen(true)}
        >
          Восстановить
        </button>
      </div>
    );
  }

  if (status === "ready" && !hasServerBackup && !hintDismissed) {
    return (
      <div className={s.banner}>
        <span className={s.bannerText}>
          Создайте резервную копию ключей — без неё переписка не откроется на других
          устройствах.
        </span>
        <button
          type="button"
          className={s.bannerAction}
          onClick={() => useUiStore.getState().setTab("settings")}
        >
          Создать
        </button>
        <button
          type="button"
          className={s.close}
          aria-label="Скрыть"
          onClick={() => {
            try {
              localStorage.setItem(BACKUP_HINT_DISMISSED_KEY, "1");
            } catch {
              // ignore
            }
            setHintDismissed(true);
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  return null;
}

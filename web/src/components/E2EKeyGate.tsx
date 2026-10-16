import { useRef, useState } from "react";
import axios from "axios";
import { useE2EStore } from "../store/e2e";
import { useUiStore } from "../store/ui";
import s from "./E2EKeyGate.module.css";

const BACKUP_HINT_DISMISSED_KEY = "quazar_e2e_backup_hint_dismissed";

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response?.status === 401) return "Неверный пароль аккаунта";
    const detail = err.response?.data?.detail;
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

/**
 * Следит, чтобы устройство работало с ключом аккаунта:
 * предлагает восстановить ключи из копии или создать копию для других устройств.
 */
export default function E2EKeyGate() {
  const status = useE2EStore((st) => st.status);
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const hasLocalKey = useE2EStore((st) => st.hasLocalKey);
  const restorePromptOpen = useE2EStore((st) => st.restorePromptOpen);
  const setRestorePromptOpen = useE2EStore((st) => st.setRestorePromptOpen);
  const busy = useE2EStore((st) => st.busy);

  const [password, setPassword] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hintDismissed, setHintDismissed] = useState(readHintDismissed);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      setPassword("");
      setAccountPassword("");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (status === "needs_restore" && restorePromptOpen) {
    const { restoreFromServer, restoreFromFile, rotate, sync, userId } = useE2EStore.getState();
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
                  onClick={() => void run(() => restoreFromServer(password))}
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
                if (file) void run(() => restoreFromFile(file, password));
              }}
            />
          </section>

          <section className={s.section}>
            <h4 className={s.sectionTitle}>Нет доступа к другим устройствам?</h4>
            <p className={s.hint}>
              Можно создать новые ключи аккаунта. Переписка, зашифрованная старым ключом, здесь
              не прочитается, а на остальных устройствах ключи придётся восстановить заново.
              Собеседники увидят предупреждение о смене ключа.
            </p>
            <input
              className={s.input}
              type="password"
              placeholder="Пароль аккаунта"
              value={accountPassword}
              onChange={(e) => setAccountPassword(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className={s.danger}
              disabled={busy || accountPassword.length < 8}
              onClick={() => void run(() => rotate(accountPassword))}
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

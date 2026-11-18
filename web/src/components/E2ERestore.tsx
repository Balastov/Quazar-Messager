import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { devicesApi, type DeviceSession } from "../api/devices";
import { clearReauth } from "../auth/reauth";
import { loggedInByCode } from "../auth/loginVia";
import { StaleBackupError, type AccountProof } from "../crypto/keys";
import { useE2EStore } from "../store/e2e";
import DeviceKeyReceiver from "./devices/DeviceKeyReceiver";
import AccountProofInput from "./profile/AccountProofInput";
import { apiErrorText } from "../utils/profile";
import s from "./E2EKeyGate.module.css";

type Route = "device" | "backup" | "fresh";

function errorText(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err) && err.response?.status === 401) {
    return err.response.data?.detail === "Invalid password" ? "Неверный пароль аккаунта" : "Сессия истекла — войдите в аккаунт заново";
  }
  return apiErrorText(err, fallback);
}

/** Куда вести сразу: другое устройство, пароль для восстановления или «начать заново». */
export function firstRoute(others: DeviceSession[] | null, hasServerBackup: boolean): Route {
  // Неизвестно (старая версия не сообщала или список не загрузился) — тоже шанс, что переписка там читается.
  if (others === null || others.some((device) => device.has_account_key !== false)) return "device";
  return hasServerBackup ? "backup" : "fresh";
}

function names(devices: DeviceSession[]): string {
  return devices.map((device) => device.name).join(", ");
}

/**
 * Переписка на этом устройстве не читается: окно с одним понятным действием. Сначала — подтвердить
 * вход на другом своём устройстве; нет к нему доступа — пароль для восстановления; нет и его — начать заново.
 */
export default function E2ERestore({ onLater }: { onLater(): void }) {
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const busy = useE2EStore((st) => st.busy);
  const userId = useE2EStore((st) => st.userId);
  const [others, setOthers] = useState<DeviceSession[] | null | undefined>(undefined);
  const [route, setRoute] = useState<Route | null>(null);

  useEffect(() => {
    let active = true;
    devicesApi
      .list()
      .then((all) => active && setOthers(all.filter((device) => !device.current)))
      .catch(() => active && setOthers(null));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (others !== undefined && route === null) setRoute(firstRoute(others, hasServerBackup));
  }, [others, route, hasServerBackup]);

  const candidates = others?.filter((device) => device.has_account_key !== false) ?? [];
  // Называем те, где переписка точно читается; если таких не знаем — возможные. Не больше трёх.
  const known = candidates.filter((device) => device.has_account_key === true);
  const named = (known.length > 0 ? known : candidates).slice(0, 3);
  const canAskDevice = others === null || candidates.length > 0;
  const noAccess = () => setRoute(hasServerBackup ? "backup" : "fresh");

  let content: React.ReactNode = <p className={s.hint}>Проверяем…</p>;
  if (route === "device") {
    const where = loggedInByCode()
      ? "на устройстве, куда пришёл код"
      : named.length > 0
        ? <>на устройстве, где вы уже в Quazar: <b>{names(named)}</b></>
        : "на устройстве, где вы уже в Quazar";
    content = (
      <>
        <h3 className={s.title}>Откройте переписку на этом устройстве</h3>
        <p className={s.lead}>Личные сообщения защищены шифрованием. Чтобы читать их здесь, подтвердите вход {where}.</p>
        {userId && <DeviceKeyReceiver userId={userId} />}
        <button type="button" className={s.link} onClick={noAccess}>
          Нет доступа к другим устройствам
        </button>
      </>
    );
  } else if (route === "backup") {
    content = <BackupRoute onForgot={() => setRoute("fresh")} onBack={canAskDevice ? () => setRoute("device") : undefined} />;
  } else if (route === "fresh") {
    content = (
      <FreshRoute
        othersCount={others?.length ?? 0}
        onFile={hasServerBackup ? undefined : () => setRoute("backup")}
        onBack={canAskDevice ? () => setRoute("device") : hasServerBackup ? () => setRoute("backup") : undefined}
      />
    );
  }

  return (
    <div className={s.overlay}>
      <div className={s.panel} role="dialog" aria-modal="true" aria-label="Открыть переписку">
        {content}
        <button type="button" className={s.later} disabled={busy} onClick={onLater}>
          Позже
        </button>
      </div>
    </div>
  );
}

interface Stale {
  blob: string;
  backupPassword: string;
}

/** Э3: пароль для восстановления (копия на сервере) или файл копии. */
function BackupRoute({ onForgot, onBack }: { onForgot(): void; onBack?: () => void }) {
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const busy = useE2EStore((st) => st.busy);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState<Stale | null>(null);
  const [proof, setProof] = useState<AccountProof | null>(null);
  const [proofRound, setProofRound] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const restore = async (fn: () => Promise<void>) => {
    setError("");
    setStale(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof StaleBackupError) {
        setStale({ blob: err.blob, backupPassword: password });
        return;
      }
      setError(errorText(err, "Не удалось открыть переписку"));
    }
  };
  const fromFile = () => {
    if (password.length < 8) {
      setError("Сначала введите пароль, которым защищён файл");
      return;
    }
    fileRef.current?.click();
  };

  return (
    <>
      <h3 className={s.title}>Введите пароль для восстановления</h3>
      <p className={s.lead}>
        Вы задали его в «Настройки → Безопасность → Восстановление переписки». Это не пароль от
        аккаунта и не код из звонка.
        {!hasServerBackup && " Копии на сервере нет — понадобится файл копии (.quazar-key)."}
      </p>
      <form
        className={s.section}
        onSubmit={(e) => {
          e.preventDefault();
          if (!hasServerBackup) fromFile();
          else if (password.length >= 8) void restore(() => useE2EStore.getState().restoreFromServer(password));
        }}
      >
        <input
          className={s.input}
          type="password"
          placeholder="Пароль для восстановления"
          aria-label="Пароль для восстановления"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className={s.primary} disabled={busy || password.length < 8}>
          {busy ? "Открываем…" : hasServerBackup ? "Открыть переписку" : "Выбрать файл копии"}
        </button>
      </form>
      <input
        ref={fileRef}
        type="file"
        accept=".quazar-key,application/octet-stream"
        className={s.hidden}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void restore(() => useE2EStore.getState().restoreFromFile(file, password));
        }}
      />
      {stale && (
        <section className={s.section}>
          <p className={s.hint}>
            Пароль подошёл, но копия сохранена до того, как ключ сменили на другом устройстве. Можно вернуть
            ключ из копии — тогда сообщения, отправленные после смены, прочитаются только на том устройстве.
          </p>
          <AccountProofInput
            key={`adopt-${proofRound}`}
            purpose="app"
            onChange={setProof}
            disabled={busy}
            inputClassName={s.input}
            buttonClassName={s.primary}
            hintClassName={s.hint}
          />
          <button
            type="button"
            className={s.primary}
            disabled={busy || !proof}
            onClick={() =>
              void restore(async () => {
                try {
                  await useE2EStore.getState().adoptBackup(stale.blob, stale.backupPassword, proof!);
                } finally {
                  clearReauth();
                  setProof(null);
                  setProofRound((n) => n + 1);
                }
              })
            }
          >
            {busy ? "Сохраняем…" : "Вернуть ключ из копии"}
          </button>
        </section>
      )}
      {error && <div className={s.statusErr} role="alert">{error}</div>}
      <div className={s.links}>
        <button type="button" className={s.link} onClick={onForgot}>
          Не помню пароль
        </button>
        {hasServerBackup && (
          <button type="button" className={s.link} disabled={busy} onClick={fromFile}>
            Из файла
          </button>
        )}
        {onBack && (
          <button type="button" className={s.link} onClick={onBack}>
            Назад
          </button>
        )}
      </div>
    </>
  );
}

/** Э4: ни другого устройства, ни пароля — новый ключ. */
function FreshRoute({ othersCount, onFile, onBack }: { othersCount: number; onFile?: () => void; onBack?: () => void }) {
  const busy = useE2EStore((st) => st.busy);
  const [proof, setProof] = useState<AccountProof | null>(null);
  const [proofRound, setProofRound] = useState(0);
  const [error, setError] = useState("");

  const start = async () => {
    setError("");
    try {
      await useE2EStore.getState().rotate(proof!);
    } catch (err) {
      setError(errorText(err, "Не удалось начать заново"));
    } finally {
      clearReauth();
      setProof(null);
      setProofRound((n) => n + 1);
    }
  };

  return (
    <>
      <h3 className={s.title}>Начать переписку заново</h3>
      <p className={s.lead}>
        Старые личные сообщения здесь прочитать не получится: ключ к ним остался там, куда у вас сейчас
        нет доступа. Новые сообщения будут читаться как обычно, а собеседники увидят пометку «ключ
        шифрования изменился».
        {othersCount > 0 && " На остальных ваших устройствах переписку нужно будет открыть заново."}
      </p>
      <section className={s.section}>
        <p className={s.hint}>Подтвердите, что это вы:</p>
        <AccountProofInput
          key={`rotate-${proofRound}`}
          purpose="app"
          onChange={setProof}
          disabled={busy}
          inputClassName={s.input}
          buttonClassName={s.primary}
          hintClassName={s.hint}
        />
        <button type="button" className={s.danger} disabled={busy || !proof} onClick={() => void start()}>
          {busy ? "Начинаем…" : "Начать заново"}
        </button>
      </section>
      {error && <div className={s.statusErr} role="alert">{error}</div>}
      <div className={s.links}>
        {onFile && (
          <button type="button" className={s.link} onClick={onFile}>
            Есть файл копии
          </button>
        )}
        {onBack && (
          <button type="button" className={s.link} onClick={onBack}>
            Назад
          </button>
        )}
      </div>
    </>
  );
}

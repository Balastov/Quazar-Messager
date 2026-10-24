import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { usersApi } from "../api/users";
import { useAuthStore } from "../store/auth";
import {
  browserPermission,
  getNotifyPrefs,
  setNotifyPrefs,
  subscribeNotifyPrefs,
  type NotifyPrefs,
} from "../notifications/prefs";
import { playSoftChime } from "../notifications/sound";
import { previewNotification, requestNotifyPermission } from "../notifications/notify";
import { ensurePushSubscription } from "../notifications/push";
import { downloadBackupFile, BackupError } from "../crypto/backup";
import { fetchKeyBackup } from "../crypto/keys";
import { useE2EStore } from "../store/e2e";
import { useCallStore } from "../store/call";
import { useUiStore } from "../store/ui";
import { DEFAULT_GLASS_TRANSPARENCY } from "../styles/glass";
import { useContactsStore } from "../store/contacts";
import ContactsImport from "./ContactsImport";
import { playStarSound, type StarSoundEvent } from "../sounds/starSounds";
import { activityTracker, IDLE_MINUTES_OPTIONS, systemIdleSupported } from "../presence/activity";
import StatusPicker from "./StatusPicker";
import { useWallpaperStore } from "../store/wallpaper";
import { prepareBackground } from "../utils/wallpaper";

const STAR_SOUNDS: [StarSoundEvent, string][] = [
  ["enter", "Вход"],
  ["leave", "Выход"],
  ["peerJoin", "Кто-то вошёл"],
  ["peerLeave", "Кто-то вышел"],
  ["knock", "Стук"],
  ["invite", "Приглашение"],
];
import UserAvatar from "./UserAvatar";
import MicCheck from "./MicCheck";
import AudioDevices from "./AudioDevices";
import { IconLogout } from "./icons";
import s from "./SettingsView.module.css";

const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg);
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function SettingsView() {
  const user = useAuthStore((st) => st.user);
  const setUser = useAuthStore((st) => st.setUser);
  const logout = useAuthStore((st) => st.logout);
  const e2eStatus = useE2EStore((st) => st.status);
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const noiseSuppression = useCallStore((st) => st.noiseSuppression);
  const toggleNoiseSuppression = useCallStore((st) => st.toggleNoiseSuppression);
  const glassTransparency = useUiStore((st) => st.glassTransparency);
  const setGlassTransparency = useUiStore((st) => st.setGlassTransparency);
  const starSounds = useUiStore((st) => st.starSounds);
  const systemIdle = useUiStore((st) => st.systemIdle);
  const setSystemIdle = useUiStore((st) => st.setSystemIdle);
  const idleMinutes = useUiStore((st) => st.idleMinutes);
  const setIdleMinutes = useUiStore((st) => st.setIdleMinutes);
  const setStarSounds = useUiStore((st) => st.setStarSounds);
  const phonebook = useContactsStore((st) => st.contacts);
  const phonebookSyncedAt = useContactsStore((st) => st.syncedAt);
  const phonebookTotal = useContactsStore((st) => st.total);
  const forgetPhonebook = useContactsStore((st) => st.forget);

  const [prefs, setPrefs] = useState<NotifyPrefs>(() => getNotifyPrefs());
  const [permission, setPermission] = useState(browserPermission);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [rotatePassword, setRotatePassword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const wallpaperRef = useRef<HTMLInputElement>(null);
  const personalWallpaper = useWallpaperStore((st) => st.personalUrl);
  const setPersonalWallpaper = useWallpaperStore((st) => st.setPersonal);
  const backupFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeNotifyPrefs(setPrefs), []);
  useEffect(() => {
    const sync = () => setPermission(browserPermission());
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  if (!user) return null;

  const permissionLabel = () => {
    if (permission === "unsupported") return "Браузер не поддерживает уведомления";
    if (permission === "granted") return "Разрешены браузером";
    if (permission === "denied") return "Заблокированы в браузере";
    return "Ещё не запрашивались";
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setError(apiErrorMessage(err, "Ошибка"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.root}>
      <div className={s.inner}>
        <h2 className={s.title}>Настройки</h2>

        <section className={s.card}>
          <div className={s.profileRow}>
            <UserAvatar username={user.username} avatarUrl={user.avatar_url} size="lg" />
            <div className={s.meta}>
              <div className={s.name}>{user.username}</div>
              <div className={s.phone}>{user.phone}</div>
            </div>
          </div>
          <h3 className={s.sectionTitle}>Аватар</h3>
          <p className={s.hint}>JPEG, PNG, WebP или GIF. Не больше 3 МБ.</p>
          <div className={s.rowBtns}>
            <button
              type="button"
              className={s.primary}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Загрузить фото
            </button>
            {user.avatar_url && (
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setUser(await usersApi.removeAvatar());
                    setStatus("Аватар удалён");
                  })
                }
              >
                Удалить
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className={s.hidden}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              void run(async () => {
                if (file.size > MAX_AVATAR_BYTES) throw new Error("Файл больше 3 МБ");
                if (!file.type.startsWith("image/")) throw new Error("Нужен файл изображения");
                setUser(await usersApi.uploadAvatar(file));
                setStatus("Аватар обновлён");
              });
            }}
          />
        </section>

        <section className={s.card}>
          <h3 className={s.sectionTitle}>Оформление</h3>
          <div className={s.sliderHead}>
            <label htmlFor="glass-transparency" className={s.toggleLabel}>
              Прозрачность
            </label>
            <span className={s.sliderValue}>{glassTransparency}%</span>
          </div>
          <input
            id="glass-transparency"
            type="range"
            min={0}
            max={100}
            step={1}
            value={glassTransparency}
            onChange={(e) => setGlassTransparency(Number(e.target.value))}
            className={s.slider}
            style={{ "--fill": `${glassTransparency}%` } as React.CSSProperties}
          />
          <div className={s.sliderScale}>
            <span>Матовое стекло</span>
            <span>Прозрачное</span>
          </div>
          {glassTransparency !== DEFAULT_GLASS_TRANSPARENCY && (
            <div className={s.rowBtns}>
              <button
                type="button"
                className={s.secondary}
                onClick={() => setGlassTransparency(DEFAULT_GLASS_TRANSPARENCY)}
              >
                По умолчанию
              </button>
            </div>
          )}

          <div className={s.wallpaperRow}>
            <div
              className={s.wallpaperPreview}
              style={{ backgroundImage: `url(${JSON.stringify(personalWallpaper ?? "/bg-desktop.jpg")})` }}
              aria-hidden
            />
            <div className={s.meta}>
              <div className={s.toggleLabel}>Фон приложения</div>
              <p className={s.hint}>
                Видите только вы — на всех своих устройствах. В чате с общим фоном и в Звезде со
                своим фоном показывается их фон.
              </p>
            </div>
          </div>
          <div className={s.rowBtns}>
            <button
              type="button"
              className={s.primary}
              disabled={busy}
              onClick={() => wallpaperRef.current?.click()}
            >
              Выбрать картинку
            </button>
            {personalWallpaper && (
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await setPersonalWallpaper(null);
                    setStatus("Вернули стандартный фон");
                  })
                }
              >
                Стандартный
              </button>
            )}
          </div>
          <input
            ref={wallpaperRef}
            aria-label="Картинка для фона приложения"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className={s.hidden}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              void run(async () => {
                await setPersonalWallpaper(await prepareBackground(file));
                setStatus("Фон приложения обновлён");
              });
            }}
          />
        </section>

        <section className={s.card}>
          <h3 className={s.sectionTitle}>Контакты из телефона</h3>
          <p className={s.hint}>
            Покажем, кто из ваших контактов уже в Quazar. Номера сверяются на сервере и не
            сохраняются: остаются только найденные люди и имена, под которыми они у вас записаны.
          </p>
          <ContactsImport />
          {phonebookSyncedAt && (
            <>
              <p className={s.hint}>
                Найдено в Quazar: {phonebook.length} (сверено контактов: {phonebookTotal}) ·
                обновлено {new Date(phonebookSyncedAt).toLocaleString("ru")}. Список — во вкладке
                «Контакты» → «Из телефона».
              </p>
              <div className={s.rowBtns}>
                <button
                  type="button"
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Удалить найденные контакты с сервера? Люди останутся в Quazar, просто пропадут из списка «Из телефона»."
                      )
                    ) {
                      void run(async () => {
                        await forgetPhonebook();
                        setStatus("Контакты удалены с сервера");
                      });
                    }
                  }}
                >
                  Очистить список
                </button>
              </div>
            </>
          )}
        </section>

        <section className={s.card}>
          <h3 className={s.sectionTitle}>Уведомления</h3>
          <p className={s.hint}>
            Статус в браузере: <span className={s.perm}>{permissionLabel()}</span>
          </p>
          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => {
                setNotifyPrefs({ enabled: e.target.checked });
                setPrefs(getNotifyPrefs());
                if (e.target.checked) {
                  void requestNotifyPermission().then((p) => {
                    setPermission(p);
                    void ensurePushSubscription();
                  });
                }
              }}
            />
            <span className={s.toggleUi} />
            <span className={s.toggleLabel}>Уведомления о сообщениях</span>
          </label>
          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={prefs.sound}
              disabled={!prefs.enabled}
              onChange={(e) => {
                setNotifyPrefs({ sound: e.target.checked });
                setPrefs(getNotifyPrefs());
                if (e.target.checked) void playSoftChime();
              }}
            />
            <span className={s.toggleUi} />
            <span className={s.toggleLabel}>Мягкий звук</span>
          </label>
          {permission !== "granted" && permission !== "unsupported" && (
            <button
              type="button"
              className={s.primary}
              onClick={() =>
                void (async () => {
                  const result = await requestNotifyPermission();
                  setPermission(result);
                  if (result === "granted") {
                    setNotifyPrefs({ enabled: true, promptDismissed: true });
                    setPrefs(getNotifyPrefs());
                    void ensurePushSubscription();
                    setStatus("Уведомления включены");
                  } else if (result === "denied") {
                    setError(
                      "Браузер заблокировал уведомления. Разрешите их в настройках сайта."
                    );
                  }
                })()
              }
            >
              Разрешить уведомления
            </button>
          )}
          {prefs.enabled && (
            <button
              type="button"
              className={s.secondary}
              onClick={() =>
                void (async () => {
                  setError(null);
                  await previewNotification();
                  if (browserPermission() !== "granted") {
                    setError(
                      "Системное уведомление не показано — разрешите уведомления в браузере."
                    );
                  } else {
                    setStatus("Тестовое уведомление отправлено (toast + звук + баннер)");
                  }
                  setPermission(browserPermission());
                })()
              }
            >
              Проверить уведомление
            </button>
          )}
        </section>

        <section className={s.card}>
          <h3 className={s.sectionTitle}>Статус «в сети»</h3>
          <p className={s.hint}>
            🟢 в сети — вы работаете с Quazar или вы в звонке, на Планете, в Комнате. 🟡 отошёл(ла) —
            на компьютере долго не трогали мышь и клавиатуру, на телефоне приложение свёрнуто или
            экран погас. 🔴 на встрече или не беспокоить — вы поставили сами. Иначе — «был(а) …».
          </p>
          <StatusPicker />
          <label className={s.selectRow}>
            <span className={s.toggleLabel}>Считать, что я отошёл, через</span>
            <select
              className={s.select}
              value={idleMinutes}
              onChange={(e) => setIdleMinutes(Number(e.target.value))}
            >
              {IDLE_MINUTES_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} мин
                </option>
              ))}
            </select>
          </label>
          <p className={s.hint}>
            Без мыши и клавиатуры на этом устройстве. Больше — если часто сидите на встречах в
            Zoom или Телемосте и не хотите выглядеть «отошедшим».
          </p>
          {systemIdleSupported() && (
            <>
              <label className={s.toggle}>
                <input
                  type="checkbox"
                  checked={systemIdle}
                  onChange={(e) => {
                    const on = e.target.checked;
                    if (!on) {
                      setSystemIdle(false);
                      activityTracker?.stopSystemIdle();
                      return;
                    }
                    void activityTracker?.startSystemIdle(true).then((ok) => {
                      setSystemIdle(ok);
                      if (!ok) setError("Браузер не дал доступ к определению простоя");
                    });
                  }}
                />
                <span className={s.toggleUi} />
                <span className={s.toggleLabel}>Точнее определять, что я отошёл</span>
              </label>
              <p className={s.hint}>
                Браузер сообщит, когда вы {idleMinutes} мин не пользуетесь компьютером вообще (в
                любых программах) или заблокировали экран. Пока вы работаете в другом окне, вы
                будете «в сети».
              </p>
            </>
          )}
        </section>

        <section className={s.card}>
          <h3 className={s.sectionTitle}>Звуки Созвездия</h3>
          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={starSounds}
              onChange={(e) => {
                setStarSounds(e.target.checked);
                if (e.target.checked) void playStarSound("peerJoin", { force: true });
              }}
            />
            <span className={s.toggleUi} />
            <span className={s.toggleLabel}>Вход и выход, стук, приглашения</span>
          </label>
          <div className={s.rowBtns}>
            {STAR_SOUNDS.map(([event, label]) => (
              <button
                key={event}
                type="button"
                className={`${s.secondary} ${s.soundBtn}`}
                onClick={() => void playStarSound(event, { force: true })}
                title="Прослушать"
              >
                ▶ {label}
              </button>
            ))}
          </div>
        </section>

        <section className={s.card}>
          <h3 className={s.sectionTitle}>Звонки</h3>
          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={noiseSuppression}
              onChange={() => void toggleNoiseSuppression()}
            />
            <span className={s.toggleUi} />
            <span className={s.toggleLabel}>Шумоподавление микрофона</span>
          </label>
          <p className={s.hint}>
            Убирает из вашего голоса клавиатуру, вентилятор, улицу и бытовые звуки. Можно
            переключать прямо во время звонка.
          </p>
          <AudioDevices />
          <MicCheck buttonClass={s.secondary} hintClass={s.hint} />
        </section>

        <section className={s.card}>
          <h3 className={s.sectionTitle}>Безопасность E2E</h3>
          <p className={s.hint}>
            Один ключ шифрования на все ваши устройства. Резервная копия шифруется паролем
            (сервер хранит только ciphertext) и нужна, чтобы открыть переписку на новом
            устройстве.
            {e2eStatus === "ready" && !hasServerBackup && " Рекомендуется создать копию."}
            {e2eStatus === "needs_restore" &&
              " Ключ этого устройства не совпадает с ключом аккаунта — восстановите ключи из копии."}
          </p>
          <input
            className={s.input}
            type="password"
            placeholder="Пароль для копии (≥8)"
            value={backupPassword}
            onChange={(e) => setBackupPassword(e.target.value)}
            disabled={busy}
          />
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
              Скачать с сервера
            </button>
          </div>

          <input
            className={s.input}
            type="password"
            placeholder="Пароль для восстановления"
            value={restorePassword}
            onChange={(e) => setRestorePassword(e.target.value)}
            disabled={busy}
          />
          <div className={s.rowBtns}>
            <button
              type="button"
              className={s.secondary}
              disabled={busy || restorePassword.length < 8}
              onClick={() =>
                void run(async () => {
                  await useE2EStore.getState().restoreFromServer(restorePassword);
                  setRestorePassword("");
                  setStatus("Ключи восстановлены");
                })
              }
            >
              Восстановить с сервера
            </button>
            <button
              type="button"
              className={s.secondary}
              disabled={busy || restorePassword.length < 8}
              onClick={() => backupFileRef.current?.click()}
            >
              Из файла
            </button>
          </div>
          <input
            ref={backupFileRef}
            type="file"
            accept=".quazar-key,application/octet-stream"
            className={s.hidden}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              void run(async () => {
                await useE2EStore.getState().restoreFromFile(file, restorePassword);
                setRestorePassword("");
                setStatus("Ключи восстановлены из файла");
              });
            }}
          />

          <input
            className={s.input}
            type="password"
            placeholder="Пароль аккаунта для ротации"
            value={rotatePassword}
            onChange={(e) => setRotatePassword(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className={s.danger}
            disabled={busy || rotatePassword.length < 8}
            onClick={() =>
              void run(async () => {
                await useE2EStore.getState().rotate(rotatePassword);
                setRotatePassword("");
                setStatus(
                  "Ключи обновлены. Создайте новую резервную копию — без неё другие устройства не смогут читать новые сообщения."
                );
              })
            }
          >
            Сменить ключи
          </button>
        </section>

        <section className={s.card}>
          <button type="button" className={s.secondary} onClick={logout}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <IconLogout size={16} /> Выйти
            </span>
          </button>
        </section>

        {status && <div className={s.statusOk}>{status}</div>}
        {error && <div className={s.statusErr}>{error}</div>}
      </div>
    </div>
  );
}

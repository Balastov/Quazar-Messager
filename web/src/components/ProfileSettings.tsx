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
import { requestNotifyPermission } from "../notifications/notify";
import UserAvatar from "./UserAvatar";
import s from "./ProfileSettings.module.css";

const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

interface Props {
  onClose: () => void;
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg);
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function ProfileSettings({ onClose }: Props) {
  const user = useAuthStore((st) => st.user);
  const setUser = useAuthStore((st) => st.setUser);
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => getNotifyPrefs());
  const [permission, setPermission] = useState(browserPermission);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const handleToggleEnabled = async (enabled: boolean) => {
    setNotifyPrefs({ enabled });
    setPrefs(getNotifyPrefs());
    if (enabled && browserPermission() === "default") {
      const result = await requestNotifyPermission();
      setPermission(result);
    }
  };

  const handleToggleSound = (sound: boolean) => {
    setNotifyPrefs({ sound });
    setPrefs(getNotifyPrefs());
    if (sound) void playSoftChime();
  };

  const handleRequestPermission = async () => {
    setError(null);
    const result = await requestNotifyPermission();
    setPermission(result);
    if (result === "granted") {
      setNotifyPrefs({ enabled: true, promptDismissed: true });
      setPrefs(getNotifyPrefs());
      setStatus("Уведомления включены");
    } else if (result === "denied") {
      setError(
        "Браузер заблокировал уведомления. Откройте настройки сайта в браузере и разрешите уведомления для quazar-msg.ru."
      );
    }
  };

  const handleAvatar = async (file: File) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (file.size > MAX_AVATAR_BYTES) {
        throw new Error("Файл больше 3 МБ");
      }
      if (!file.type.startsWith("image/")) {
        throw new Error("Нужен файл изображения");
      }
      const updated = await usersApi.uploadAvatar(file);
      setUser(updated);
      setStatus("Аватар обновлён");
    } catch (err) {
      setError(apiErrorMessage(err, "Не удалось загрузить аватар"));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveAvatar = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const updated = await usersApi.removeAvatar();
      setUser(updated);
      setStatus("Аватар удалён");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить аватар");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <h3 className={s.title}>Профиль</h3>
          <button type="button" className={s.close} onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <section className={s.profileCard}>
          <UserAvatar username={user.username} avatarUrl={user.avatar_url} size="lg" />
          <div className={s.profileMeta}>
            <div className={s.username}>{user.username}</div>
            <div className={s.phone}>{user.phone}</div>
          </div>
        </section>

        <section className={s.section}>
          <h4 className={s.sectionTitle}>Аватар</h4>
          <p className={s.hint}>JPEG, PNG, WebP или GIF. Не больше 3 МБ.</p>
          <div className={s.row}>
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
                onClick={() => void handleRemoveAvatar()}
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
              if (file) void handleAvatar(file);
              e.target.value = "";
            }}
          />
        </section>

        <section className={s.section}>
          <h4 className={s.sectionTitle}>Уведомления</h4>
          <p className={s.hint}>
            Статус в браузере: <strong className={s.perm}>{permissionLabel()}</strong>
          </p>

          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => void handleToggleEnabled(e.target.checked)}
            />
            <span className={s.toggleUi} />
            <span className={s.toggleLabel}>Уведомления о новых сообщениях</span>
          </label>

          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={prefs.sound}
              disabled={!prefs.enabled}
              onChange={(e) => handleToggleSound(e.target.checked)}
            />
            <span className={s.toggleUi} />
            <span className={s.toggleLabel}>Мягкий звук</span>
          </label>

          {permission !== "granted" && permission !== "unsupported" && (
            <button
              type="button"
              className={s.primary}
              onClick={() => void handleRequestPermission()}
            >
              {permission === "denied" ? "Как включить в браузере" : "Разрешить уведомления"}
            </button>
          )}

          {permission === "denied" && (
            <p className={s.hint}>
              В Chrome/Safari: значок замка или «Аа» слева от адреса → Уведомления → Разрешить.
              Затем нажмите кнопку выше ещё раз.
            </p>
          )}

          {prefs.enabled && prefs.sound && (
            <button type="button" className={s.secondary} onClick={() => void playSoftChime()}>
              Прослушать звук
            </button>
          )}
        </section>

        {status && <div className={s.statusOk}>{status}</div>}
        {error && <div className={s.statusErr}>{error}</div>}
      </div>
    </div>
  );
}

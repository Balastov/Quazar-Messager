import { useEffect, useState } from "react";
import {
  browserPermission,
  getNotifyPrefs,
  setNotifyPrefs,
  subscribeNotifyPrefs,
  type NotifyPrefs,
} from "../../notifications/prefs";
import { playSoftChime } from "../../notifications/sound";
import { requestNotifyPermission } from "../../notifications/notify";
import { ensurePushSubscription } from "../../notifications/push";
import { playStarSound, type StarSoundEvent } from "../../sounds/starSounds";
import { useUiStore } from "../../store/ui";
import ConnectionDiagnostics from "../ConnectionDiagnostics";
import { useSettingsRun } from "./useSettingsRun";
import s from "../SettingsView.module.css";

const STAR_SOUNDS: [StarSoundEvent, string][] = [
  ["enter", "Вход"],
  ["leave", "Выход"],
  ["peerJoin", "Кто-то вошёл"],
  ["peerLeave", "Кто-то вышел"],
  ["knock", "Стук"],
  ["invite", "Приглашение"],
];

export default function NotificationsSection() {
  const starSounds = useUiStore((st) => st.starSounds);
  const setStarSounds = useUiStore((st) => st.setStarSounds);
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => getNotifyPrefs());
  const [permission, setPermission] = useState(browserPermission);
  const { setStatus, setError, feedback } = useSettingsRun();

  useEffect(() => subscribeNotifyPrefs(setPrefs), []);
  useEffect(() => {
    const sync = () => setPermission(browserPermission());
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const permissionLabel =
    permission === "unsupported"
      ? "Браузер не поддерживает уведомления"
      : permission === "granted"
        ? "Разрешены браузером"
        : permission === "denied"
          ? "Заблокированы в браузере"
          : "Ещё не запрашивались";

  return (
    <>
      <section className={s.card}>
        <h3 className={s.sectionTitle}>Сообщения</h3>
        <p className={s.hint}>
          Статус в браузере: <span className={s.perm}>{permissionLabel}</span>
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
          <span className={s.toggleLabel}>Звук сообщений</span>
        </label>
        {permission !== "granted" && permission !== "unsupported" && (
          <div className={s.rowBtns}>
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
                    setError("Браузер заблокировал уведомления. Разрешите их в настройках сайта.");
                  }
                })()
              }
            >
              Разрешить уведомления
            </button>
          </div>
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
        <h3 className={s.sectionTitle}>Проверка</h3>
        <p className={s.hint}>
          Не приходят уведомления, не слышно звонка или вас не слышат — проверьте по шагам, что
          доходит до этого устройства.
        </p>
        <ConnectionDiagnostics />
      </section>
      {feedback}
    </>
  );
}

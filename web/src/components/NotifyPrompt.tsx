import { useEffect, useState } from "react";
import {
  browserPermission,
  getNotifyPrefs,
  setNotifyPrefs,
  subscribeNotifyPrefs,
} from "../notifications/prefs";
import { requestNotifyPermission } from "../notifications/notify";
import s from "./NotifyPrompt.module.css";

export default function NotifyPrompt() {
  const [visible, setVisible] = useState(false);

  const refresh = () => {
    const prefs = getNotifyPrefs();
    const perm = browserPermission();
    setVisible(prefs.enabled && !prefs.promptDismissed && perm === "default");
  };

  useEffect(() => {
    refresh();
    return subscribeNotifyPrefs(refresh);
  }, []);

  if (!visible) return null;

  return (
    <div className={s.banner}>
      <div className={s.text}>
        <strong>Уведомления</strong>
        <span>Включите, чтобы не пропускать сообщения в фоне</span>
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={s.allow}
          onClick={() => {
            void (async () => {
              await requestNotifyPermission();
              setNotifyPrefs({ promptDismissed: true, enabled: true });
              refresh();
            })();
          }}
        >
          Включить
        </button>
        <button
          type="button"
          className={s.later}
          onClick={() => {
            setNotifyPrefs({ promptDismissed: true });
            setVisible(false);
          }}
        >
          Позже
        </button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useE2EStore } from "../store/e2e";
import { useUiStore } from "../store/ui";
import s from "./E2EKeyGate.module.css";
import { useTourStore } from "../tour/store";
import E2ERestore from "./E2ERestore";
import KeyRequestPrompt, { useIncomingKeyRequest } from "./devices/KeyRequestPrompt";

const BACKUP_HINT_DISMISSED_KEY = "quazar_e2e_backup_hint_dismissed";

function readHintDismissed(): boolean {
  try {
    return localStorage.getItem(BACKUP_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Следит, чтобы переписка читалась на этом устройстве: открывает её с другого своего устройства
 * (или по паролю для восстановления), спрашивает «Это вы входите?», когда её просит новое устройство,
 * и напоминает задать пароль для восстановления.
 */
export default function E2EKeyGate() {
  const status = useE2EStore((st) => st.status);
  const hasServerBackup = useE2EStore((st) => st.hasServerBackup);
  const restorePromptOpen = useE2EStore((st) => st.restorePromptOpen);
  const setRestorePromptOpen = useE2EStore((st) => st.setRestorePromptOpen);
  const [hintDismissed, setHintDismissed] = useState(readHintDismissed);
  // Строка сверху закрывает поиск и заголовки — её можно убрать до следующего запуска.
  const [bannerHidden, setBannerHidden] = useState(false);
  // Отдать переписку другому устройству можно, только если здесь она читается.
  const keyRequest = useIncomingKeyRequest(status === "ready");
  // В настройках о переписке говорит сама страница — строка сверху её бы закрывала.
  const inSettings = useUiStore((st) => st.tab === "settings");
  // Во время обучения окна и строки сверху не нужны: они закрывают то, что обучение подсвечивает.
  const touring = useTourStore((st) => !!st.active || !!st.finished);

  // Окно открывается само, когда выяснилось, что переписка здесь не читается, — если обучение уже
  // идёт, оно подождёт: окно под рамкой обучения спутало бы экран. Покажется сразу после.
  if (touring) return null;

  if (status === "needs_restore" && restorePromptOpen) {
    return <E2ERestore onLater={() => setRestorePromptOpen(false)} />;
  }

  if (status === "needs_restore" && !inSettings && !bannerHidden) {
    return (
      <div className={`${s.banner} ${s.bannerWarn} ${s.bannerWrap}`} role="status">
        <span className={s.bannerText}>Личные сообщения на этом устройстве пока не читаются.</span>
        <button type="button" className={s.bannerAction} onClick={() => setRestorePromptOpen(true)}>
          Открыть переписку
        </button>
        <button type="button" className={`${s.close} ${s.bannerClose}`} aria-label="Скрыть" title="Скрыть" onClick={() => setBannerHidden(true)}>
          ✕
        </button>
      </div>
    );
  }

  if (status === "ready" && keyRequest.request) {
    return <KeyRequestPrompt key={keyRequest.request.id} incoming={{ ...keyRequest, request: keyRequest.request }} />;
  }

  if (status === "ready" && !hasServerBackup && !hintDismissed && !inSettings) {
    return (
      <div className={s.banner}>
        <span className={s.bannerText}>
          Задайте пароль для восстановления — он вернёт переписку, если все ваши устройства окажутся
          недоступны.
        </span>
        <button
          type="button"
          className={s.bannerAction}
          onClick={() => useUiStore.getState().openSettings("security")}
        >
          Задать
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

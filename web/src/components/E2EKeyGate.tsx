import { useState } from "react";
import { useE2EStore } from "../store/e2e";
import { useUiStore } from "../store/ui";
import s from "./E2EKeyGate.module.css";
import { useTourStore } from "../tour/store";
import { usePresenting } from "../notifications/presenting";
import E2ERestore from "./E2ERestore";
import KeyRequestPrompt, { useIncomingKeyRequest } from "./devices/KeyRequestPrompt";

/**
 * Следит, чтобы переписка читалась на этом устройстве: открывает её с другого своего устройства
 * (или после проверки номера), и спрашивает «Это вы входите?», когда её просит новое устройство.
 * Пароль для восстановления не навязываем: он необязателен, как зашифрованная копия в WhatsApp.
 */
export default function E2EKeyGate() {
  const status = useE2EStore((st) => st.status);
  const restorePromptOpen = useE2EStore((st) => st.restorePromptOpen);
  const setRestorePromptOpen = useE2EStore((st) => st.setRestorePromptOpen);
  // Строка сверху закрывает поиск и заголовки — её можно убрать до следующего запуска.
  const [bannerHidden, setBannerHidden] = useState(false);
  // Отдать переписку другому устройству можно, только если здесь она читается.
  const keyRequest = useIncomingKeyRequest(status === "ready");
  // В настройках о переписке говорит сама страница — строка сверху её бы закрывала.
  const inSettings = useUiStore((st) => st.tab === "settings");
  // Во время обучения окна и строки сверху не нужны: они закрывают то, что обучение подсвечивает.
  const touring = useTourStore((st) => !!st.active || !!st.finished);
  // «Это вы входите?» во время демонстрации экрана подождёт: зрители увидели бы код сверки.
  // Уже начатую сверку не прячем.
  const presenting = usePresenting();

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

  if (status === "ready" && keyRequest.request && (!presenting || keyRequest.engaged)) {
    return <KeyRequestPrompt key={keyRequest.request.id} incoming={{ ...keyRequest, request: keyRequest.request }} />;
  }

  return null;
}

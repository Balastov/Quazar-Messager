import { useState } from "react";
import { useScreenAudio } from "../store/screenAudio";
import type { ScreenMode } from "../calls/screenCapture";
import Dialog from "./constellation/Dialog";
import s from "./constellation/Constellation.module.css";

export default function ScreenShareDialog({ onStart, onClose, quality = true, audioSupported = true }: {
  onStart: (mode: ScreenMode, shareAudio: boolean) => void; onClose: () => void;
  quality?: boolean; audioSupported?: boolean;
}) {
  const shareAudio = useScreenAudio((st) => st.shareAudio);
  const setShareAudio = useScreenAudio((st) => st.setShareAudio);
  const [mode, setMode] = useState<ScreenMode>("detail");
  return <Dialog title="Демонстрация экрана" onClose={onClose}>
    {quality && <label className={s.label}>Качество
      <select className={s.input} value={mode} onChange={(e) => setMode(e.target.value as ScreenMode)}>
        <option value="detail">Чётко — текст и документы</option>
        <option value="motion">Плавно — игры и видео, 30 к/с</option>
      </select>
    </label>}
    <label className={s.label}>Поделиться звуком
      <select className={s.input} value={audioSupported && shareAudio ? "yes" : "no"} disabled={!audioSupported}
        onChange={(e) => setShareAudio(e.target.value === "yes")}>
        <option value="no">Нет</option><option value="yes">Да</option>
      </select>
    </label>
    <p className={s.hint}>{audioSupported
      ? "Далее выберите экран, окно или вкладку в окне браузера. Доступность звука зависит от браузера и системы; если есть переключатель передачи звука, включите его."
      : "Собеседник использует приложение без отдельной дорожки звука трансляции. Для передачи звука обеим сторонам нужна обновлённая веб-версия."}</p>
    <button type="button" className={s.primary} onClick={() => { onStart(mode, audioSupported && shareAudio); onClose(); }}>
      Выбрать источник и начать
    </button>
  </Dialog>;
}

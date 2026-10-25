import { useEffect } from "react";
import { formatDuration } from "../../attachments/voice";
import { IconSend } from "../icons";
import s from "./Voice.module.css";

interface Props {
  elapsed: number;
  /** Последние замеры громкости 0…1 — живая волна. */
  levels: number[];
  onCancel: () => void;
  onSend: () => void;
}

/** Вместо поля ввода, пока идёт запись: отмена, таймер, живая волна, отправить. */
export default function VoiceRecorderBar({ elapsed, levels, onCancel, onSend }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSend();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, onSend]);

  return (
    <div className={s.recorder} role="group" aria-label="Запись голосового">
      <button type="button" className={s.cancel} onClick={onCancel} aria-label="Отменить запись" title="Esc">
        ✕
      </button>
      <span className={s.recDot} aria-hidden />
      <span className={s.recTime}>{formatDuration(elapsed)}</span>
      <div className={s.liveWave} aria-hidden>
        {levels.map((v, i) => (
          <span key={i} className={s.liveBar} style={{ height: `${Math.max(8, v * 100)}%` }} />
        ))}
      </div>
      <button type="button" className={s.send} onClick={onSend} aria-label="Отправить голосовое" title="Enter">
        <IconSend size={18} />
      </button>
    </div>
  );
}

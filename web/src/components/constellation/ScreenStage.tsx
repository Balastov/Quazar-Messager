import { useEffect, useRef, useState } from "react";
import type { VoiceScreen } from "../../store/voice";
import s from "./Constellation.module.css";

interface Props {
  /** Кто показывает (по данным сервера). */
  sharerName: string;
  /** Видео в комнате; null — показ начинается, трек ещё не дошёл. */
  screen: VoiceScreen | null;
  isMine: boolean;
  /** Остановить: свой показ — всегда, чужой — модератор. */
  onStop?: () => void;
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Сцена Планеты: трансляция экрана на всю ширину, с полноэкранным режимом. */
export default function ScreenStage({ sharerName, screen, isMine, onStop }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<FullscreenVideo>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const track = !isMine ? (screen?.track ?? null) : null;

  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const frame = frameRef.current;
    if (frame?.requestFullscreen) void frame.requestFullscreen().catch(() => {});
    // iPhone: полноэкранным может быть только само видео.
    else videoRef.current?.webkitEnterFullscreen?.();
  };

  if (isMine) {
    // Своё видео не показываем: при показе всего экрана получится «зеркальный коридор».
    return (
      <div className={s.screenStage}>
        <div className={s.screenMine}>
          <span className={s.screenMineIcon}>🖥</span>
          <span className={s.screenMineTitle}>Вы показываете экран</span>
          <span className={s.hint}>Все на Планете видят его. Звук вкладки тоже слышен, если вы его включили.</span>
          {onStop && (
            <button type="button" className={s.danger} onClick={onStop}>
              Остановить показ
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={s.screenStage}>
      <div ref={frameRef} className={`${s.screenFrame} ${fullscreen ? s.screenFrameFull : ""}`}>
        {track ? (
          <video ref={videoRef} className={s.screenVideo} autoPlay playsInline muted />
        ) : (
          <div className={s.screenWaiting}>{sharerName} начинает показ экрана…</div>
        )}
        <div className={s.screenBar}>
          <span className={s.screenLabel}>🖥 {sharerName}</span>
          {onStop && (
            <button type="button" className={`${s.danger} ${s.small}`} onClick={onStop}>
              Остановить показ
            </button>
          )}
          {track && (
            <button
              type="button"
              className={`${s.secondary} ${s.small}`}
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"}
              title={fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"}
            >
              {fullscreen ? "↙" : "⛶"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

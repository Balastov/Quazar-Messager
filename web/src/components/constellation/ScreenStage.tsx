import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { VoiceScreen } from "../../store/voice";
import s from "./Constellation.module.css";

interface Props {
  /** Кто показывает (по данным сервера). */
  sharerName: string;
  /** «на Планете» / «в Комнате». */
  placeInside: string;
  /** Видео в комнате; null — показ начинается, трек ещё не дошёл. */
  screen: VoiceScreen | null;
  isMine: boolean;
  /** Остановить: свой показ — всегда, чужой — модератор. */
  onStop?: () => void;
  /** Та же панель разговора, что под сценой, — внутри полноэкранного просмотра. */
  controls?: ReactNode;
}

/** Сцена Планеты: трансляция экрана на всю ширину, с полноэкранным режимом. */
export default function ScreenStage({ sharerName, placeInside, screen, isMine, onStop, controls }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fullscreen = nativeFullscreen || expanded;
  const track = !isMine ? (screen?.track ?? null) : null;

  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, expanded]);

  useEffect(() => {
    const onChange = () => setNativeFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const toggleFullscreen = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (document.fullscreenElement === frameRef.current) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    const frame = frameRef.current;
    if (frame?.requestFullscreen) void frame.requestFullscreen().catch(() => setExpanded(true));
    // Браузеры без полноэкранного контейнера: разворачиваем внутри страницы.
    // Нативный режим одного видео скрывает все кнопки разговора.
    else setExpanded(true);
  };

  if (isMine) {
    // Своё видео не показываем: при показе всего экрана получится «зеркальный коридор».
    return (
      <div className={s.screenStage}>
        <div className={s.screenMine}>
          <span className={s.screenMineIcon}>🖥</span>
          <span className={s.screenMineTitle}>Вы показываете экран</span>
          <span className={s.hint}>
            Все {placeInside} видят его. Звук вкладки тоже слышен, если вы его включили.
          </span>
          {onStop && (
            <button type="button" className={s.danger} onClick={onStop}>
              Остановить показ
            </button>
          )}
        </div>
      </div>
    );
  }

  const frame = (
    <div
      ref={frameRef}
      className={`${s.screenFrame} ${fullscreen ? s.screenFrameFull : ""} ${expanded ? s.screenFrameOverlay : ""}`}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? "Демонстрация экрана" : undefined}
    >
      <div className={s.screenMedia}>
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
          {(track || fullscreen) && (
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
      {fullscreen && controls && <div className={s.screenControls}>{controls}</div>}
    </div>
  );

  return <div className={s.screenStage}>{expanded ? createPortal(frame, document.body) : frame}</div>;
}

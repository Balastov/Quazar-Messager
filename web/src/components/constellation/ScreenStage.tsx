import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { VoiceScreen } from "../../store/voice";
import type { ScreenPointer } from "../../api/roomActivities";
import { containedVideo, pointerColor } from "./roomActivityMath";
import a from "./RoomActivities.module.css";
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
  audioControls?: ReactNode;
  pointersEnabled?: boolean;
  pointers?: (ScreenPointer & { expires: number })[];
  onPoint?: (x: number, y: number) => void;
  onTogglePointers?: () => void;
}

const BAR_KEY = "quazar-screen-bar-collapsed";

function readBarCollapsed(): boolean {
  try { return localStorage.getItem(BAR_KEY) === "1"; } catch { return false; }
}

/** Сцена Планеты: трансляция экрана на всю ширину, с полноэкранным режимом. Панель показа —
 * строкой над картинкой (ничего не закрывает) и сворачивается. */
export default function ScreenStage({ sharerName, placeInside, screen, isMine, onStop, controls,
  audioControls, pointersEnabled = false, pointers = [], onPoint, onTogglePointers }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [previewMine, setPreviewMine] = useState(false);
  const [pointMode, setPointMode] = useState(false);
  // Панель показа можно свернуть — в углу останется кнопка, чтобы вернуть её. Выбор помним.
  const [barCollapsed, setBarCollapsed] = useState(readBarCollapsed);
  const collapseBar = (value: boolean) => {
    setBarCollapsed(value);
    try { localStorage.setItem(BAR_KEY, value ? "1" : "0"); } catch { /* только на этот раз */ }
  };
  const [pointerNow, setPointerNow] = useState(Date.now);
  const mediaRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<ReturnType<typeof containedVideo>>(null);
  const fullscreen = nativeFullscreen || expanded;
  const track = !isMine || previewMine ? (screen?.track ?? null) : null;

  useEffect(() => { if (!pointersEnabled) setPointMode(false); }, [pointersEnabled]);
  useEffect(() => {
    const active = pointers.filter((pointer) => pointer.expires > Date.now());
    if (!active.length) return;
    const timeout = setTimeout(() => setPointerNow(Date.now()), Math.max(1, Math.min(...active.map((pointer) => pointer.expires)) - Date.now() + 10));
    return () => clearTimeout(timeout);
  }, [pointers, pointerNow]);

  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, expanded]);

  useEffect(() => {
    const video = videoRef.current, media = mediaRef.current;
    if (!video || !media) { setBounds(null); return; }
    const update = () => setBounds(containedVideo(media.clientWidth, media.clientHeight, video.videoWidth, video.videoHeight));
    update();
    video.addEventListener("loadedmetadata", update);
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(media);
    return () => { observer?.disconnect(); video.removeEventListener("loadedmetadata", update); window.removeEventListener("resize", update); };
  }, [track, fullscreen, expanded, previewMine]);

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

  const pointerToggle = onTogglePointers && <button type="button" className={`${s.secondary} ${s.small}`}
    aria-pressed={pointersEnabled} onClick={onTogglePointers}>{pointersEnabled ? "Выключить указатели" : "Разрешить указатели"}</button>;

  if (isMine && !previewMine) {
    // Своё видео не показываем: при показе всего экрана получится «зеркальный коридор».
    return (
      <div className={s.screenStage}>
        <div className={s.screenMine}>
          <span className={s.screenMineIcon}>🖥</span>
          <span className={s.screenMineTitle}>Вы показываете экран</span>
          <span className={s.hint}>
            Все {placeInside} видят его. Звук вкладки тоже слышен, если вы его включили.
          </span>
          {pointerToggle}
          {screen?.track && <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setPreviewMine(true)}>
            Показать миниатюру с указателями
          </button>}
          {pointersEnabled && <span className={a.previewHint}>Участники могут ставить метки. Они видны в просмотрщике Quazar.</span>}
          {onStop && (
            <button type="button" className={s.danger} onClick={onStop}>
              Остановить показ
            </button>
          )}
        </div>
        {audioControls}
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
      {!barCollapsed && <div className={s.screenBar}>
        <span className={s.screenLabel}>🖥 {sharerName}</span>
        {pointerToggle}
        {onPoint && track && <button type="button" className={`${s.secondary} ${s.small}`} aria-pressed={pointMode}
          onClick={() => setPointMode(!pointMode)}>{pointMode ? "Указатель включён" : "Указатель"}</button>}
        {isMine && <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => {
          setExpanded(false); setPreviewMine(false);
          if (nativeFullscreen) void document.exitFullscreen().catch(() => {});
        }}>Скрыть миниатюру</button>}
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
        <button type="button" className={s.screenBarToggle} onClick={() => collapseBar(true)}
          aria-label="Свернуть панель показа" title="Свернуть панель — картинке больше места">
          ▴ Свернуть
        </button>
      </div>}
      <div ref={mediaRef} className={s.screenMedia}>
        {barCollapsed && <button type="button" className={`${s.screenBarToggle} ${s.screenBarRestore}`}
          onClick={() => collapseBar(false)} aria-label="Показать панель показа" title={`🖥 ${sharerName} — показать панель`}>
          ▾ Панель
        </button>}
        {track ? (
          <video ref={videoRef} className={s.screenVideo} autoPlay playsInline muted />
        ) : (
          <div className={s.screenWaiting}>{sharerName} начинает показ экрана…</div>
        )}
        {bounds && pointersEnabled && <div className={a.pointerOverlay} role="group" aria-label="Указатели на демонстрации"
          style={{ ...bounds, pointerEvents: pointMode && onPoint ? "auto" : "none", cursor: pointMode ? "crosshair" : undefined }}
          onPointerDown={(event) => {
            if (!onPoint || !pointMode || event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onPoint(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
              Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)));
          }}>
          {pointers.filter((pointer) => pointer.expires > Date.now() && pointer.sharer_id === screen?.userId).map((pointer) => <div key={pointer.user_id} className={a.pointer}
            style={{ left: `${pointer.x * 100}%`, top: `${pointer.y * 100}%`, color: pointerColor(pointer.user_id) }}>
            <span>{pointer.name}</span>
          </div>)}
        </div>}
      </div>
      {fullscreen && (controls || audioControls) && <div className={s.screenControls}>{controls}{audioControls}</div>}
    </div>
  );

  return <div className={s.screenStage}>{expanded ? createPortal(frame, document.body) : frame}{!fullscreen && audioControls}</div>;
}

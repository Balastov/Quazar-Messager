import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ScreenPointer } from "../../api/roomActivities";
import type { VoiceScreen } from "../../store/voice";
import ScreenStage from "./ScreenStage";
import s from "./Constellation.module.css";

/** Один показ экрана в комнате: чей, его видео и что с ним можно делать. */
export interface StageScreen {
  userId: string;
  name: string;
  screen: VoiceScreen | null;
  isMine: boolean;
  onStop?: () => void;
  audioControls?: ReactNode;
  pointersEnabled: boolean;
  onPoint?: (x: number, y: number) => void;
  onTogglePointers?: () => void;
}

interface Props {
  screens: StageScreen[];
  /** «в Комнате» / «на Планете». */
  placeInside: string;
  /** Панель разговора — внутри полноэкранного просмотра. */
  controls?: ReactNode;
  pointers?: (ScreenPointer & { expires: number })[];
}

const PHONE_QUERY = "(max-width: 767px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  return narrow;
}

/**
 * Показы экрана в комнате. Один — как раньше, на всю ширину. Два (рабочая Комната) — рядом,
 * экран поделён пополам; любой можно открыть крупно или развернуть на весь экран, а можно
 * развернуть на весь экран оба сразу. На телефоне — по одному, с переключателем.
 */
export default function ScreenStages({ screens, placeInside, controls, pointers = [] }: Props) {
  const narrow = useNarrow();
  // null — оба рядом (на телефоне — первый).
  const [focus, setFocus] = useState<string | null>(null);
  const pairRef = useRef<HTMLDivElement>(null);
  const [pairFull, setPairFull] = useState(false);

  // Показ, который смотрели крупно, закончился — возвращаемся к тому, что осталось.
  useEffect(() => {
    if (focus && !screens.some((sc) => sc.userId === focus)) setFocus(null);
  }, [focus, screens]);

  useEffect(() => {
    const onChange = () => setPairFull(!!pairRef.current && document.fullscreenElement === pairRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const stage = (sc: StageScreen) => (
    <ScreenStage
      key={sc.userId}
      sharerName={sc.name}
      placeInside={placeInside}
      screen={sc.screen}
      isMine={sc.isMine}
      onStop={sc.onStop}
      controls={controls}
      audioControls={sc.audioControls}
      pointersEnabled={sc.pointersEnabled}
      pointers={pointers}
      onPoint={sc.onPoint}
      onTogglePointers={sc.onTogglePointers}
    />
  );

  if (screens.length < 2) return screens[0] ? stage(screens[0]) : null;

  const switcher = (withBoth: boolean) => (
    <div className={s.screenSwitch} role="group" aria-label="Какой показ смотреть">
      {withBoth && (
        <button type="button" className={focus === null ? s.screenSwitchActive : s.screenSwitchButton}
          aria-pressed={focus === null} onClick={() => setFocus(null)}>
          Оба рядом
        </button>
      )}
      {screens.map((sc) => {
        const active = withBoth ? focus === sc.userId : (focus ?? screens[0].userId) === sc.userId;
        return (
          <button key={sc.userId} type="button" className={active ? s.screenSwitchActive : s.screenSwitchButton}
            aria-pressed={active} onClick={() => setFocus(sc.userId)}>
            🖥 {sc.isMine ? "Ваш экран" : sc.name}
          </button>
        );
      })}
    </div>
  );

  if (narrow) {
    const shown = screens.find((sc) => sc.userId === focus) ?? screens[0];
    return (
      <div className={s.screenStage}>
        {switcher(false)}
        {stage(shown)}
      </div>
    );
  }

  if (focus) {
    const shown = screens.find((sc) => sc.userId === focus) ?? screens[0];
    return (
      <div className={s.screenStage}>
        {switcher(true)}
        {stage(shown)}
      </div>
    );
  }

  const canFullscreen = typeof document !== "undefined" && !!document.documentElement.requestFullscreen;
  const toggleFull = () => {
    if (document.fullscreenElement === pairRef.current) void document.exitFullscreen().catch(() => {});
    else void pairRef.current?.requestFullscreen().catch(() => {});
  };

  return (
    <div className={s.screenStage}>
      <div className={s.screenPairBar}>
        {switcher(true)}
        {canFullscreen && (
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={toggleFull}
            aria-label="Оба показа на весь экран" title="Оба показа на весь экран">
            ⛶ Оба на весь экран
          </button>
        )}
      </div>
      <div ref={pairRef} className={`${s.screenPair} ${pairFull ? s.screenPairFull : ""}`}>
        <div className={s.screenPairGrid}>{screens.map(stage)}</div>
        {pairFull && (
          <div className={s.screenPairControls}>
            <button type="button" className={`${s.secondary} ${s.small}`} onClick={toggleFull}>
              ↙ Выйти из полноэкранного режима
            </button>
            {controls}
          </div>
        )}
      </div>
    </div>
  );
}

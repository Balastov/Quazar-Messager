/**
 * Шумоподавление: вариант (без обработки / RNNoise / GTCRN) и порог микрофона с ползунком.
 * В окне «Микрофон и динамик» (звонок, Комната) и в настройках звонков. Всё применяется сразу,
 * в том числе к идущему разговору; во время разговора рядом с ползунком — уровень вашего микрофона.
 */
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  GATE_MAX_DB,
  GATE_MIN_DB,
  engineFailedOnThisDevice,
  getMicGateLevelPref,
  getMicGatePref,
  getNoiseEnginePref,
  setMicGatePref,
  setNoiseEnginePref,
  subscribeNoisePrefs,
  watchLiveGateMeter,
  type GateMeter,
  type NoiseEngine,
} from "../calls/noiseSuppression";
import settings from "./SettingsView.module.css";
import s from "./NoiseControls.module.css";

export type NoiseMode = "off" | NoiseEngine;

const MODES: { id: NoiseMode; title: string; hint: string; strength: number }[] = [
  { id: "off", title: "Без обработки", hint: "Только базовый фильтр браузера", strength: 0 },
  { id: "rnnoise", title: "RNNoise", hint: "Лёгкая: вентилятор, гул, улица", strength: 2 },
  { id: "gtcrn", title: "GTCRN", hint: "Сильная: ещё клавиатура и геймпад", strength: 3 },
];

export function useNoiseEngine(): NoiseEngine {
  return useSyncExternalStore(subscribeNoisePrefs, getNoiseEnginePref);
}

export function useMicGate(): { gateDb: number | null; level: number } {
  const gateDb = useSyncExternalStore(subscribeNoisePrefs, getMicGatePref);
  const level = useSyncExternalStore(subscribeNoisePrefs, getMicGateLevelPref);
  return { gateDb, level };
}

export function formatDb(db: number): string {
  return `${db < 0 ? "−" : ""}${Math.abs(db)} дБ`;
}

/** Шкала индикатора, дБ. */
const METER_FLOOR = -80;
const METER_TOP = -10;
const meterPct = (db: number) => Math.min(100, Math.max(0, ((db - METER_FLOOR) / (METER_TOP - METER_FLOOR)) * 100));

/** Полоса громкости перед порогом с отметкой порога. */
export function GateMeterBar({ meter, gateDb }: { meter: GateMeter; gateDb: number | null }) {
  const open = gateDb === null || meter.open;
  return (
    <>
      <div className={s.meter} role="meter" aria-label="Громкость микрофона после нейросети"
        aria-valuemin={METER_FLOOR} aria-valuemax={METER_TOP} aria-valuenow={Math.round(meter.levelDb)}>
        <div className={open ? s.fillOpen : s.fillClosed} style={{ width: `${meterPct(meter.levelDb)}%` }} />
        {gateDb !== null && <div className={s.mark} style={{ left: `${meterPct(gateDb)}%` }} />}
      </div>
      {gateDb !== null && (
        <p className={open ? s.open : s.closed} role="status">
          {open ? "Собеседники вас слышат" : "Тишина — собеседники ничего не слышат"}
        </p>
      )}
    </>
  );
}

/** Уровень микрофона, который сейчас в разговоре; null — разговора с шумоподавлением нет. */
function useLiveGateMeter(): GateMeter | null {
  const [meter, setMeter] = useState<GateMeter | null>(null);
  useEffect(() => {
    let stale: ReturnType<typeof setTimeout> | undefined;
    const stop = watchLiveGateMeter((next) => {
      setMeter(next);
      clearTimeout(stale);
      // Микрофон закрыли — уровень перестал приходить.
      stale = setTimeout(() => setMeter(null), 1000);
    });
    return () => {
      stop();
      clearTimeout(stale);
    };
  }, []);
  return meter;
}

export default function NoiseControls({ enabled, toggle, live = false, divided = false }: {
  /** Шумоподавление включено (стор звонка или Планеты). */
  enabled: boolean;
  toggle: () => void | Promise<void>;
  /** Идёт разговор: показывать уровень своего микрофона у порога. */
  live?: boolean;
  /** Отделить чертой от блока выше (окно «Микрофон и динамик»). */
  divided?: boolean;
}) {
  const engine = useNoiseEngine();
  const { gateDb, level } = useMicGate();
  const mode: NoiseMode = enabled ? engine : "off";
  const name = useId();

  const pick = (next: NoiseMode) => {
    if (next === "off") {
      if (enabled) void toggle();
      return;
    }
    if (next !== engine) setNoiseEnginePref(next);
    if (!enabled) void toggle();
  };

  return (
    <div className={divided ? `${s.root} ${s.divided}` : s.root}>
      <div className={s.group} role="radiogroup" aria-label="Шумоподавление">
        <span className={settings.toggleLabel}>Шумоподавление</span>
        {MODES.map((item) => {
          const checked = item.id === mode;
          return (
            <label key={item.id} className={checked ? `${s.option} ${s.checked}` : s.option}>
              <input type="radio" name={name} checked={checked} onChange={() => pick(item.id)} />
              <span className={s.radio} aria-hidden />
              <span className={s.text}>
                <span className={s.name}>
                  {item.title}
                  {item.id === "gtcrn" && <span className={s.badge}>по умолчанию</span>}
                </span>
                <span className={s.hint}>
                  {item.hint}
                  {checked && item.id !== "off" && engineFailedOnThisDevice(item.id) &&
                    ". На этом устройстве не заработала — используется RNNoise"}
                </span>
              </span>
              <span className={s.strength} aria-hidden>
                {[1, 2, 3].map((bar) => (
                  <span key={bar} className={bar <= item.strength ? s.barOn : s.bar} style={{ height: 4 + bar * 4 }} />
                ))}
              </span>
            </label>
          );
        })}
      </div>

      <GateControls enabled={enabled} gateDb={gateDb} level={level} live={live} />
    </div>
  );
}

function GateControls({ enabled, gateDb, level, live }: {
  enabled: boolean;
  gateDb: number | null;
  level: number;
  live: boolean;
}) {
  const on = gateDb !== null;
  const sliderId = useId();
  return (
    <fieldset className={s.gate} disabled={!enabled}>
      <label className={settings.toggle}>
        <input type="checkbox" checked={on} onChange={() => setMicGatePref(on ? null : level)} />
        <span className={settings.toggleUi} />
        <span className={settings.toggleLabel}>Порог микрофона</span>
      </label>
      <p className={s.hint}>
        {enabled
          ? "Пока вы молчите, собеседники не слышат ничего: ни клавиатуру, ни геймпад, ни мышь. Короткие щелчки порог не открывают."
          : "Порог работает вместе с шумоподавлением — выберите RNNoise или GTCRN."}
      </p>
      {on && (
        <>
          <div className={settings.sliderHead}>
            <label htmlFor={sliderId} className={settings.toggleLabel}>Чувствительность</label>
            <span className={settings.sliderValue}>{formatDb(level)}</span>
          </div>
          <input
            id={sliderId}
            type="range"
            min={GATE_MIN_DB}
            max={GATE_MAX_DB}
            step={1}
            value={level}
            onChange={(e) => setMicGatePref(Number(e.target.value))}
            className={settings.slider}
            style={{ "--fill": `${((level - GATE_MIN_DB) / (GATE_MAX_DB - GATE_MIN_DB)) * 100}%` } as React.CSSProperties}
          />
          <div className={settings.sliderScale}>
            <span>Пропускает тихий голос</span>
            <span>Только громкую речь</span>
          </div>
          {live && enabled && <LiveMeter gateDb={gateDb} />}
        </>
      )}
    </fieldset>
  );
}

function LiveMeter({ gateDb }: { gateDb: number }) {
  const meter = useLiveGateMeter();
  if (!meter) return null;
  return (
    <div className={s.live}>
      <p className={s.hint}>Ваш микрофон сейчас — полоса правее отметки, когда вы говорите:</p>
      <GateMeterBar meter={meter} gateDb={gateDb} />
    </div>
  );
}

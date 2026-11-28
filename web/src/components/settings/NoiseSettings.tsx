/**
 * Настройки шумоподавления: вкл/выкл, нейросеть (RNNoise или GTCRN), порог микрофона
 * с индикатором по живому голосу и запись для сравнения нейросетей на слух.
 * Всё применяется сразу, в том числе к идущему разговору.
 */
import { useEffect, useRef, useState } from "react";
import {
  GATE_MAX_DB,
  GATE_MIN_DB,
  NOISE_ENGINES,
  NoiseSuppressedMic,
  engineFailedOnThisDevice,
  getMicGateLevelPref,
  getMicGatePref,
  setMicGatePref,
  setNoiseEnginePref,
  type GateMeter,
  type NoiseEngine,
} from "../../calls/noiseSuppression";
import { getMicrophone } from "../../calls/devices";
import { useCallStore } from "../../store/call";
import { useNoiseEngine } from "../NoiseMenu";
import { micErrorText, useVoiceStore } from "../../store/voice";
import s from "../SettingsView.module.css";
import n from "./NoiseSettings.module.css";

const ENGINE_TEXT: Record<NoiseEngine, { title: string; hint: string }> = {
  rnnoise: {
    title: "Обычная (RNNoise)",
    hint: "Лёгкая. Хорошо убирает ровный фон: вентилятор, гул, улицу.",
  },
  gtcrn: {
    title: "Сильная (GTCRN) — по умолчанию",
    hint: "Лучше убирает клавиатуру, щелчки и отрывистые звуки. Немного сильнее нагружает процессор.",
  },
};

const TUNE_MS = 30_000;
const RECORD_MS = 8_000;
/** Шкала индикатора, дБ. */
const METER_FLOOR = -80;
const METER_TOP = -10;

function meterPct(db: number): number {
  return Math.min(100, Math.max(0, ((db - METER_FLOOR) / (METER_TOP - METER_FLOOR)) * 100));
}

function formatDb(db: number): string {
  return `${db < 0 ? "−" : ""}${Math.abs(db)} дБ`;
}

function openMic() {
  // Как в разговоре: встроенное шумоподавление браузера выключено, работает наше.
  return getMicrophone({ echoCancellation: true, autoGainControl: true, noiseSuppression: false });
}

export default function NoiseSettings() {
  const noiseSuppression = useCallStore((st) => st.noiseSuppression);
  const toggleNoiseSuppression = useCallStore((st) => st.toggleNoiseSuppression);
  const callPhase = useCallStore((st) => st.phase);
  const voice = useVoiceStore((st) => st.status);
  const busy = !["idle", "ended"].includes(callPhase) || voice !== "idle";

  const engine = useNoiseEngine();
  const [gateOn, setGateOn] = useState(() => getMicGatePref() !== null);
  const [gateDb, setGateDb] = useState(getMicGateLevelPref);

  const chooseEngine = (next: NoiseEngine) => setNoiseEnginePref(next);
  const toggleGate = () => {
    setGateOn(!gateOn);
    setMicGatePref(gateOn ? null : gateDb);
  };
  const changeGate = (db: number) => {
    setGateDb(db);
    if (gateOn) setMicGatePref(db);
  };

  return (
    <section className={s.card}>
      <label className={s.toggle}>
        <input type="checkbox" checked={noiseSuppression} onChange={() => void toggleNoiseSuppression()} />
        <span className={s.toggleUi} />
        <span className={s.toggleLabel}>Шумоподавление микрофона</span>
      </label>
      <p className={s.hint}>
        Убирает из вашего голоса клавиатуру, вентилятор, улицу и бытовые звуки. Когда выключено,
        работает более слабое встроенное шумоподавление браузера. Во время звонка вариант выбирается
        кнопкой шумодава.
      </p>

      <fieldset className={n.group} disabled={!noiseSuppression}>
        <legend className={s.toggleLabel}>Нейросеть</legend>
        {NOISE_ENGINES.map((id) => (
          <label key={id} className={n.option}>
            <input type="radio" name="noise-engine" checked={engine === id} onChange={() => chooseEngine(id)} />
            <span>
              <span className={n.optionTitle}>{ENGINE_TEXT[id].title}</span>
              <span className={s.hint}>
                {ENGINE_TEXT[id].hint}
                {engine === id && engineFailedOnThisDevice(id) && " На этом устройстве она не заработала — в разговорах используется обычная."}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className={n.group} disabled={!noiseSuppression}>
        <label className={s.toggle}>
          <input type="checkbox" checked={gateOn} onChange={toggleGate} />
          <span className={s.toggleUi} />
          <span className={s.toggleLabel}>Порог микрофона</span>
        </label>
        <p className={s.hint}>
          Пока вы молчите, собеседники не слышат ничего: ни клавиатуру, ни геймпад, ни мышь. Короткие
          щелчки порог не открывают. Звуки во время речи он не убирает — это работа нейросети.
        </p>
        {gateOn && (
          <>
            <div className={s.sliderHead}>
              <label htmlFor="mic-gate" className={s.toggleLabel}>Порог</label>
              <span className={s.sliderValue}>{formatDb(gateDb)}</span>
            </div>
            <input
              id="mic-gate"
              type="range"
              min={GATE_MIN_DB}
              max={GATE_MAX_DB}
              step={1}
              value={gateDb}
              onChange={(e) => changeGate(Number(e.target.value))}
              className={s.slider}
              style={{ "--fill": `${((gateDb - GATE_MIN_DB) / (GATE_MAX_DB - GATE_MIN_DB)) * 100}%` } as React.CSSProperties}
            />
            <div className={s.sliderScale}>
              <span>Пропускает тихий голос</span>
              <span>Только громкую речь</span>
            </div>
          </>
        )}
        {gateOn && <GateTuner disabled={busy} gateDb={gateDb} />}
      </fieldset>

      {noiseSuppression && <Compare disabled={busy} gateDb={gateOn ? gateDb : null} />}
      {busy && noiseSuppression && (
        <p className={s.hint}>Проверить по голосу можно вне звонка и голосовой комнаты. Настройки же применяются к разговору сразу.</p>
      )}
    </section>
  );
}

/** Живой индикатор: громкость после нейросети и отметка порога. */
function GateTuner({ disabled, gateDb }: { disabled: boolean; gateDb: number }) {
  const [state, setState] = useState<"idle" | "starting" | "running">("idle");
  const [meter, setMeter] = useState<GateMeter>({ levelDb: -100, open: false });
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);
  useEffect(() => {
    if (disabled) stopRef.current?.();
  }, [disabled]);

  const start = async () => {
    if (state !== "idle" || disabled) return;
    setState("starting");
    setError(null);
    let cancelled = false;
    let stream: MediaStream | null = null;
    let mic: NoiseSuppressedMic | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      cancelled = true;
      clearTimeout(timer);
      mic?.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (stopRef.current === stop) stopRef.current = null;
      setState("idle");
    };
    stopRef.current = stop;
    try {
      stream = await openMic();
      if (cancelled) return stop();
      const raw = stream.getAudioTracks()[0];
      if (!raw) throw new Error("Микрофон не предоставил аудиодорожку");
      mic = await NoiseSuppressedMic.create(raw, { force: true });
      if (cancelled) return stop();
      if (!mic) throw new Error("Шумоподавление недоступно в этом браузере.");
      mic.onGateMeter = setMeter;
      mic.setMeter(true);
      timer = setTimeout(stop, TUNE_MS);
      setState("running");
    } catch (err) {
      stop();
      setError(err instanceof Error && !(err instanceof DOMException) ? err.message : micErrorText(err));
    }
  };

  return (
    <div className={n.tool}>
      {state === "idle" ? (
        <button type="button" className={s.secondary} disabled={disabled} onClick={() => void start()}>
          Настроить по голосу
        </button>
      ) : (
        <>
          <p className={s.hint} role="status">
            {state === "starting"
              ? "Разрешите доступ к микрофону…"
              : "Помолчите и постучите по клавиатуре — полоса должна быть левее отметки. Потом скажите несколько слов — правее."}
          </p>
          {state === "running" && (
            <>
              <div className={n.meter} aria-label="Громкость микрофона после нейросети" role="meter"
                aria-valuemin={METER_FLOOR} aria-valuemax={METER_TOP} aria-valuenow={Math.round(meter.levelDb)}>
                <div className={meter.open ? n.fillOpen : n.fillClosed} style={{ width: `${meterPct(meter.levelDb)}%` }} />
                <div className={n.mark} style={{ left: `${meterPct(gateDb)}%` }} />
              </div>
              <p className={meter.open ? n.open : n.closed} role="status">
                {meter.open ? "Собеседники вас слышат" : "Тишина — собеседники ничего не слышат"}
              </p>
            </>
          )}
          <button type="button" className={s.secondary} onClick={() => stopRef.current?.()}>
            Остановить
          </button>
        </>
      )}
      {error && <p className={n.closed} role="alert">{error}</p>}
    </div>
  );
}

interface Take {
  id: string;
  title: string;
  url: string;
}

/** Одна запись — сразу через обе нейросети: сравнить на слух с клавиатурой и геймпадом. */
function Compare({ disabled, gateDb }: { disabled: boolean; gateDb: number | null }) {
  const [state, setState] = useState<"idle" | "recording">("idle");
  const [left, setLeft] = useState(0);
  const [takes, setTakes] = useState<Take[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const urls = useRef<string[]>([]);

  const forget = () => {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
  };
  useEffect(() => () => {
    stopRef.current?.();
    forget();
  }, []);
  useEffect(() => {
    if (disabled) stopRef.current?.();
  }, [disabled]);

  const record = async () => {
    if (state !== "idle" || disabled) return;
    if (typeof MediaRecorder === "undefined") {
      setError("Запись звука недоступна в этом браузере.");
      return;
    }
    setState("recording");
    setError(null);
    setLeft(RECORD_MS / 1000);
    forget();
    setTakes([]);

    let cancelled = false;
    let stream: MediaStream | null = null;
    const mics: NoiseSuppressedMic[] = [];
    const release = () => {
      mics.forEach((mic) => mic.close());
      stream?.getTracks().forEach((t) => t.stop());
    };
    stopRef.current = () => {
      cancelled = true;
      release();
      setState("idle");
    };

    try {
      stream = await openMic();
      if (cancelled) return release();
      const raw = stream.getAudioTracks()[0];
      if (!raw) throw new Error("Микрофон не предоставил аудиодорожку");
      const gateNote = gateDb === null ? "" : ` + порог ${formatDb(gateDb)}`;
      const variants: { id: string; title: string; track: MediaStreamTrack }[] = [
        { id: "raw", title: "Без шумоподавления", track: raw },
      ];
      for (const engine of NOISE_ENGINES) {
        const mic = await NoiseSuppressedMic.create(raw, { force: true, engine, gateDb, followSettings: false });
        if (mic) mics.push(mic);
        if (cancelled) return release();
        // create() мог откатиться на RNNoise — не выдаём её за другую нейросеть.
        if (mic && mic.engine === engine) {
          variants.push({ id: engine, title: ENGINE_TEXT[engine].title + gateNote, track: mic.track });
        }
      }

      const recorders: MediaRecorder[] = [];
      const recorded = Promise.all(
        variants.map(
          (variant) =>
            new Promise<Take | null>((resolve) => {
              const chunks: Blob[] = [];
              const recorder = new MediaRecorder(new MediaStream([variant.track]));
              recorders.push(recorder);
              recorder.ondataavailable = (event) => {
                if (event.data.size) chunks.push(event.data);
              };
              recorder.onstop = () => {
                if (cancelled || !chunks.length) return resolve(null);
                const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
                urls.current.push(url);
                resolve({ id: variant.id, title: variant.title, url });
              };
              recorder.start();
            })
        )
      );
      const finish = () => recorders.forEach((recorder) => recorder.state !== "inactive" && recorder.stop());
      const timer = setTimeout(finish, RECORD_MS);
      stopRef.current = () => {
        cancelled = true;
        clearTimeout(timer);
        finish();
      };
      const results = await recorded;
      release();
      stopRef.current = null;
      if (!cancelled) setTakes(results.filter((take): take is Take => take !== null));
      setState("idle");
    } catch (err) {
      release();
      stopRef.current = null;
      setState("idle");
      setError(err instanceof Error && !(err instanceof DOMException) ? err.message : micErrorText(err));
    }
  };

  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [state]);

  return (
    <div className={n.tool}>
      <p className={s.toggleLabel}>Сравнить на слух</p>
      <p className={s.hint}>
        Запишем {RECORD_MS / 1000} секунд сразу через обе нейросети. Говорите и одновременно печатайте или
        нажимайте кнопки геймпада, потом послушайте, что услышат собеседники. Запись остаётся на этом устройстве.
      </p>
      {state === "idle" ? (
        <button type="button" className={s.secondary} disabled={disabled} onClick={() => void record()}>
          {takes.length ? "Записать заново" : "Записать пример"}
        </button>
      ) : (
        <>
          <p className={s.hint} role="status">Идёт запись… {left} с</p>
          <button type="button" className={s.secondary} onClick={() => stopRef.current?.()}>
            Отменить
          </button>
        </>
      )}
      {takes.map((take) => (
        <div key={take.id} className={n.take}>
          <span>{take.title}</span>
          <audio controls src={take.url} preload="auto" />
        </div>
      ))}
      {error && <p className={n.closed} role="alert">{error}</p>}
    </div>
  );
}

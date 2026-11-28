/**
 * Настройки шумоподавления: вариант и порог (тот же блок, что в окне «Микрофон и динамик»),
 * плюс проверка порога по живому голосу и запись для сравнения нейросетей на слух.
 * Всё применяется сразу, в том числе к идущему разговору.
 */
import { useEffect, useRef, useState } from "react";
import { NOISE_ENGINES, NoiseSuppressedMic, type GateMeter } from "../../calls/noiseSuppression";
import { getMicrophone } from "../../calls/devices";
import { useCallStore } from "../../store/call";
import { micErrorText, useVoiceStore } from "../../store/voice";
import NoiseControls, { GateMeterBar, formatDb, useMicGate } from "../NoiseControls";
import s from "../SettingsView.module.css";
import n from "./NoiseSettings.module.css";

const ENGINE_TITLE = { rnnoise: "RNNoise", gtcrn: "GTCRN" } as const;
const TUNE_MS = 30_000;
const RECORD_MS = 8_000;

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
  const { gateDb } = useMicGate();

  return (
    <section className={s.card}>
      <NoiseControls enabled={noiseSuppression} toggle={toggleNoiseSuppression} live={busy} />
      <p className={s.hint}>
        Во время разговора то же самое — в окне «Микрофон и динамик»; кнопка шумодава просто включает
        и выключает его.
      </p>
      {noiseSuppression && gateDb !== null && !busy && <GateTuner gateDb={gateDb} />}
      {noiseSuppression && <Compare disabled={busy} gateDb={gateDb} />}
      {busy && noiseSuppression && (
        <p className={s.hint}>Проверить по записи можно вне звонка и голосовой комнаты.</p>
      )}
    </section>
  );
}

/** Живой индикатор: громкость после нейросети и отметка порога. */
function GateTuner({ gateDb }: { gateDb: number }) {
  const [state, setState] = useState<"idle" | "starting" | "running">("idle");
  const [meter, setMeter] = useState<GateMeter>({ levelDb: -100, open: false });
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const start = async () => {
    if (state !== "idle") return;
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
        <button type="button" className={s.secondary} onClick={() => void start()}>
          Настроить по голосу
        </button>
      ) : (
        <>
          <p className={s.hint} role="status">
            {state === "starting"
              ? "Разрешите доступ к микрофону…"
              : "Помолчите и постучите по клавиатуре — полоса должна быть левее отметки. Потом скажите несколько слов — правее."}
          </p>
          {state === "running" && <GateMeterBar meter={meter} gateDb={gateDb} />}
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
          variants.push({ id: engine, title: ENGINE_TITLE[engine] + gateNote, track: mic.track });
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

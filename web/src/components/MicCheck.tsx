import { useEffect, useRef, useState } from "react";
import {
  clearFailedOnThisDevice,
  failedOnThisDevice,
  NoiseSuppressedMic,
} from "../calls/noiseSuppression";
import { micErrorText } from "../store/voice";
import s from "./MicCheck.module.css";

interface Props {
  buttonClass: string;
  hintClass: string;
}

type Verdict = "checking" | "working" | "failed" | "unavailable";

/**
 * Проверка микрофона и шумоподавления: уровень до и после RNNoise в реальном времени
 * плюс технические сведения — по скриншоту видно, где пропадает звук.
 */
export default function MicCheck({ buttonClass, hintClass }: Props) {
  const [running, setRunning] = useState(false);
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  const [verdict, setVerdict] = useState<Verdict>("checking");
  const [tech, setTech] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  };

  const start = async () => {
    setError(null);
    setVerdict("checking");
    setLevels({ input: 0, output: 0 });
    const flaggedBefore = failedOnThisDevice();
    let raw: MediaStreamTrack;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, autoGainControl: true, noiseSuppression: false },
      });
      raw = stream.getAudioTracks()[0];
    } catch (err) {
      setError(micErrorText(err));
      return;
    }

    const denoiser = await NoiseSuppressedMic.create(raw, { force: true });
    const settings = raw.getSettings();
    const info = [
      `Браузер: ${navigator.userAgent}`,
      `Микрофон: ${raw.label || "—"}`,
      `Микрофон: ${settings.sampleRate ?? "?"} Гц, каналов ${settings.channelCount ?? "?"}, ` +
        `эхоподавление ${String(settings.echoCancellation ?? "?")}`,
      `RNNoise: ${denoiser ? "создан" : "не создан (браузер не поддерживает или аудио не запустилось)"}`,
      denoiser ? `Аудиоконтекст: ${denoiser.sampleRate} Гц, ${denoiser.contextState}` : "",
      `Раньше отказывал на этом устройстве: ${flaggedBefore ? "да" : "нет"}`,
    ].filter(Boolean);
    setTech(info.join("\n"));
    if (!denoiser) setVerdict("unavailable");

    // Без RNNoise меряем просто микрофон.
    let fallbackProbe: { ctx: AudioContext; analyser: AnalyserNode } | null = null;
    if (!denoiser) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(new MediaStream([raw])).connect(analyser);
      fallbackProbe = { ctx, analyser };
    }
    const buffer = new Float32Array(2048);

    const timer = setInterval(() => {
      if (denoiser) {
        const now = denoiser.levels();
        setLevels(now);
        const state = denoiser.watchdog.state;
        if (state !== "checking") {
          setVerdict(state);
          if (state === "working") clearFailedOnThisDevice();
        }
        setTech(
          [
            ...info,
            denoiser.processorError ? `Ошибка AudioWorklet: ${denoiser.processorError}` : "",
            `Сейчас: вход ${now.input.toFixed(4)}, выход ${now.output.toFixed(4)}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } else if (fallbackProbe) {
        fallbackProbe.analyser.getFloatTimeDomainData(buffer);
        let max = 0;
        for (const v of buffer) max = Math.max(max, Math.abs(v));
        setLevels({ input: max, output: 0 });
      }
    }, 150);

    stopRef.current = () => {
      clearInterval(timer);
      denoiser?.close();
      void fallbackProbe?.ctx.close();
      raw.stop();
    };
    setRunning(true);
  };

  const pct = (v: number) => `${Math.min(100, Math.round(Math.sqrt(v) * 100))}%`;

  return (
    <div className={s.root}>
      {!running ? (
        <button type="button" className={buttonClass} onClick={() => void start()}>
          Проверить микрофон
        </button>
      ) : (
        <>
          <p className={hintClass}>Скажите что-нибудь обычным голосом.</p>
          <div className={s.meter}>
            Микрофон
            <div className={s.bar}>
              <div className={s.fill} style={{ width: pct(levels.input) }} />
            </div>
          </div>
          {verdict !== "unavailable" && (
            <div className={s.meter}>
              После шумоподавления — так вас слышат
              <div className={s.bar}>
                <div className={s.fill} style={{ width: pct(levels.output) }} />
              </div>
            </div>
          )}
          <div
            className={`${s.verdict} ${verdict === "working" ? s.ok : verdict === "checking" ? "" : s.bad}`}
          >
            {verdict === "checking" && "Проверяем… говорите несколько секунд"}
            {verdict === "working" && "✓ Шумоподавление работает"}
            {verdict === "failed" &&
              "Шумоподавление в этом браузере выдаёт тишину. В разговорах оно будет само выключаться — вас будет слышно через обычный микрофон."}
            {verdict === "unavailable" &&
              "Шумоподавление в этом браузере не запускается — в разговорах используется обычный микрофон."}
          </div>
          <pre className={s.tech}>{tech}</pre>
          <button type="button" className={buttonClass} onClick={stop}>
            Закончить проверку
          </button>
        </>
      )}
      {error && <div className={s.bad}>{error}</div>}
    </div>
  );
}

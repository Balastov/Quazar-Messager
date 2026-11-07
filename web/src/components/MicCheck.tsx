import { useEffect, useRef, useState } from "react";
import { clearFailedOnThisDevice, failedOnThisDevice, NoiseSuppressedMic } from "../calls/noiseSuppression";
import { getMicrophone } from "../calls/devices";
import { micErrorText } from "../store/voice";
import s from "./MicCheck.module.css";

interface Props { buttonClass: string; hintClass: string; disabled?: boolean }
type Verdict = "checking" | "working" | "failed" | "unavailable";

/** Local-only level check, including the noise suppression used by calls. */
export default function MicCheck({ buttonClass, hintClass, disabled = false }: Props) {
  const [running, setRunning] = useState(false), [pending, setPending] = useState(false), [finished, setFinished] = useState(false);
  const [levels, setLevels] = useState({ input: 0, output: 0 }), [heard, setHeard] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>("checking"), [tech, setTech] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null), generation = useRef(0), mounted = useRef(false), opened = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; stopRef.current?.(); };
  }, []);
  const stop = () => {
    generation.current++; stopRef.current?.(); stopRef.current = null;
    setRunning(false); setPending(false); setFinished(opened.current);
  };
  useEffect(() => { if (disabled) { generation.current++; stopRef.current?.(); stopRef.current = null; setRunning(false); setPending(false); } }, [disabled]);
  const start = async () => {
    if (disabled || pending || running || stopRef.current) return;
    const current = ++generation.current; opened.current = false;
    setPending(true); setFinished(false); setHeard(false); setError(null); setTech(""); setVerdict("checking"); setLevels({ input: 0, output: 0 });
    let stream: MediaStream | null = null, denoiser: NoiseSuppressedMic | null = null, context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true; clearInterval(timer); clearTimeout(timeout);
      denoiser?.close(); void context?.close(); stream?.getTracks().forEach(track => track.stop());
      if (stopRef.current === cleanup) stopRef.current = null;
    };
    stopRef.current = cleanup;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Проверка микрофона недоступна. Откройте Quazar по HTTPS или в приложении.");
      const flaggedBefore = failedOnThisDevice();
      stream = await getMicrophone({ echoCancellation: true, autoGainControl: true, noiseSuppression: false });
      if (!mounted.current || current !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      opened.current = true;
      const raw = stream.getAudioTracks()[0];
      if (!raw) throw new Error("Микрофон не предоставил аудиодорожку");
      denoiser = await NoiseSuppressedMic.create(raw, { force: true });
      if (!mounted.current || current !== generation.current) { denoiser?.close(); cleanup(); return; }
      let analyser: AnalyserNode | null = null;
      if (!denoiser) {
        context = new AudioContext(); await context.resume();
        if (!mounted.current || current !== generation.current) { cleanup(); return; }
        analyser = context.createAnalyser(); analyser.fftSize = 2048;
        context.createMediaStreamSource(stream).connect(analyser);
        setVerdict("unavailable");
      }
      const settings = raw.getSettings(), buffer = new Float32Array(2048);
      setTech([`Микрофон: ${raw.label || "системный"}`, `Частота: ${settings.sampleRate ?? "?"} Гц`,
        `RNNoise: ${denoiser ? "запущен" : "недоступен"}`, `Ранее отключался: ${flaggedBefore ? "да" : "нет"}`].join("\n"));
      timer = setInterval(() => {
        if (!mounted.current || current !== generation.current) return;
        if (denoiser) {
          const value = denoiser.levels(); setLevels(value); if (value.input > .01) setHeard(true);
          const state = denoiser.watchdog.state;
          if (state !== "checking") { setVerdict(state); if (state === "working") clearFailedOnThisDevice(); }
        } else if (analyser) {
          analyser.getFloatTimeDomainData(buffer);
          const input = buffer.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
          setLevels({ input, output: 0 }); if (input > .01) setHeard(true);
        }
      }, 150);
      timeout = setTimeout(stop, 8000); setPending(false); setRunning(true);
    } catch (error) {
      cleanup();
      if (mounted.current && current === generation.current) {
        setError(micErrorText(error).replace(/«Включить микрофон»/g, "«Проверить микрофон»")); setPending(false); setRunning(false);
      }
    }
  };
  const pct = (value: number) => Math.min(100, Math.round(Math.sqrt(value) * 100));
  return <div className={s.root}>
    <p className={hintClass}>Звук проверяется только на этом устройстве и никуда не отправляется. Проверка остановится через восемь секунд.</p>
    {!running && !pending ? <button type="button" className={buttonClass} disabled={disabled} onClick={() => void start()}>Проверить микрофон</button> : <>
      <p className={hintClass} role="status">{pending ? "Разрешите доступ к микрофону в браузере или системе…" : "Скажите несколько слов обычным голосом."}</p>
      {running && <>
        <label className={s.meter}>Микрофон<progress max={100} value={pct(levels.input)} aria-label="Уровень микрофона" /></label>
        {verdict !== "unavailable" && <label className={s.meter}>После шумоподавления<progress max={100} value={pct(levels.output)} aria-label="Уровень после шумоподавления" /></label>}
      </>}
      <button type="button" className={buttonClass} onClick={stop}>Остановить проверку</button>
    </>}
    {finished && <p className={heard ? s.ok : s.bad} role="status">{heard ? "Микрофон улавливает ваш голос." : "Во время проверки звук не обнаружен. Проверьте аппаратное выключение микрофона и выберите нужное устройство в настройках звонков."}</p>}
    {verdict === "failed" && <p className={s.bad} role="status">Шумоподавление выдаёт тишину. В разговорах Quazar будет использовать обычный микрофон; можно отключить шумоподавление в настройках звонков.</p>}
    {verdict === "unavailable" && <p className={hintClass}>Шумоподавление недоступно. Проверяется обычный микрофон.</p>}
    {verdict === "working" && <p className={s.ok}>Шумоподавление работает.</p>}
    {tech && <details><summary>Технические сведения</summary><pre className={s.tech}>{tech}</pre></details>}
    {error && <p className={s.bad} role="alert">{error}</p>}
  </div>;
}

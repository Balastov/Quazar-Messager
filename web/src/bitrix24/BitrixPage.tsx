import { useEffect, useRef, useState } from "react";
import { launchContext, type BitrixContext } from "./context";

declare global {
  interface Window { BX24?: { init: (ready: () => void) => void; installFinish: () => void } }
}

export default function BitrixPage() {
  const [context, setContext] = useState<BitrixContext | null>(null);
  const [error, setError] = useState("");
  const [installation, setInstallation] = useState(false);
  const [media, setMedia] = useState("");
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const stop = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void launchContext().then(value => { if (active) setContext(value); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; mounted.current = false; stop.current?.(); };
  }, []);
  async function test(kind: "audio" | "video" | "screen") {
    if (busy || !context) return;
    setBusy(true); setMedia(""); setLevel(0);
    let stream: MediaStream | undefined, audio: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true; clearInterval(timer); clearTimeout(timeout);
      stream?.getTracks().forEach(track => track.stop());
      void audio?.close(); if (mounted.current) setBusy(false); stop.current = null;
    };
    stop.current = cleanup;
    try {
      if (!navigator.mediaDevices) throw new Error("Захват медиа недоступен в этом окне.");
      stream = kind === "screen"
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : await navigator.mediaDevices.getUserMedia({ audio: kind === "audio", video: kind === "video" });
      if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      setMedia(kind === "audio" ? "Скажите несколько слов: индикатор должен двигаться." : "Разрешение получено. Захват автоматически остановится через 8 секунд.");
      if (kind === "audio") {
        audio = new AudioContext(); await audio.resume();
        if (stopped) { void audio.close(); return; }
        const analyser = audio.createAnalyser(); analyser.fftSize = 2048;
        audio.createMediaStreamSource(stream).connect(analyser);
        const values = new Float32Array(2048);
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(values);
          setLevel(Math.min(100, Math.round(Math.max(...values.map(Math.abs)) * 500)));
        }, 100);
      }
      timeout = setTimeout(cleanup, 8000);
    } catch (err) {
      if (!stopped) setMedia(err instanceof DOMException && err.name === "NotAllowedError"
        ? "Доступ не получен. Проверьте разрешение браузера и ограничения встроенного окна Б24. Можно повторить проверку или открыть Квазар отдельно."
        : "Не удалось получить устройство. Проверьте, что оно подключено и доступно в этом окне.");
      cleanup();
    }
  }
  function finishInstallation() {
    if (!window.BX24) { setError("Не загрузилась связь с Б24. Откройте приложение из портала заново."); return; }
    window.BX24.init(() => { window.BX24!.installFinish(); setInstallation(true); });
  }
  return <main className="b24-shell">
    <header><img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} width="48" height="48" alt="" /><div><h1>Квазар</h1><p>Рабочее пространство в Битрикс24</p></div></header>
    {error ? <p role="alert" className="b24-error">{error}</p> : !context ? <p role="status">Проверяем запуск из Битрикс24…</p> : <>
      <section><h2>Здравствуйте, {context.display_name}</h2><p>Портал: {new URL(context.portal).hostname}</p><p>Битрикс24 подтвердил вашу учётную запись. Привязка аккаунта Квазара появится на следующем этапе пилота.</p>
        {context.mode === "install" && <button disabled={installation} onClick={finishInstallation}>{installation ? "Установка завершена" : "Завершить установку в Б24"}</button>}
      </section>
      <section><h2>Проверка связи</h2><p>Проверяем доступ к устройствам внутри Б24. Звук и изображение никуда не отправляются. Каждый захват остановится через 8 секунд.</p>
        <div className="b24-actions"><button disabled={busy} onClick={() => void test("audio")}>Микрофон</button><button disabled={busy} onClick={() => void test("video")}>Камера</button><button disabled={busy} onClick={() => void test("screen")}>Демонстрация экрана</button>{busy && <button onClick={() => stop.current?.()}>Остановить</button>}</div>
        {busy && <progress max={100} value={level} aria-label="Уровень микрофона" />}
        {media && <p role="status">{media}</p>}
      </section>
      <a href="https://quazar-msg.ru/" target="_blank" rel="noopener noreferrer">Открыть Квазар отдельным окном</a>
    </>}
  </main>;
}

import { useEffect, useRef, useState } from "react";
import { starsApi, type RecordingTranscript as Transcript } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { apiError } from "./rules";
import r from "./RecordingCard.module.css";

function duration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Сохранённый общий текст встречи; очередь продолжает работать после закрытия вкладки. */
export default function RecordingTranscript({ starId, recordingId }: { starId: string; recordingId: string }) {
  const userId = useAuthStore((state) => state.user?.id);
  const [value, setValue] = useState<Transcript | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const revision = useRef(0);
  const reload = useRef<(() => void) | null>(null);

  useEffect(() => {
    const current = ++revision.current;
    setValue(null); setConsent(false); setBusy(false); setError(null); setExpanded(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await starsApi.recordingTranscript(starId, recordingId);
        if (revision.current !== current) return;
        setValue(next); setError(null);
        // Редкий опрос и после готовности: другой участник мог запустить или продолжить задание.
        timer = setTimeout(() => void load(), next.status === "queued" || next.status === "running" ? 3000 : 30_000);
      } catch (err) {
        if (revision.current !== current) return;
        setValue(null); setError(apiError(err, "Не удалось загрузить расшифровку"));
        timer = setTimeout(() => void load(), 30_000);
      }
    };
    reload.current = () => { clearTimeout(timer); void load(); };
    if (userId) void load();
    return () => { revision.current++; clearTimeout(timer); reload.current = null; };
  }, [starId, recordingId, userId]);

  const start = async () => {
    if (busy) return;
    const current = revision.current;
    setBusy(true); setConsent(false); setError(null);
    try {
      const next = await starsApi.transcribeRecording(starId, recordingId);
      if (revision.current === current) { setValue(next); reload.current?.(); }
    } catch (err) {
      if (revision.current === current) setError(apiError(err, "Не удалось начать расшифровку"));
    } finally {
      if (revision.current === current) setBusy(false);
    }
  };

  const download = () => {
    if (!value?.text) return;
    const url = URL.createObjectURL(new Blob([value.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `Расшифровка встречи ${recordingId}.txt`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!userId) return null;
  if (!value) return error ? <div className={r.error} role="alert">{error}</div> : null;
  if (!value.enabled && value.status === "idle") return null;
  const processing = value.status === "queued" || value.status === "running";
  return <div className={r.transcript}>
    {processing && <div className={r.meta} role="status">
      {value.status === "queued" ? "Расшифровка в очереди" : value.total_seconds
        ? `Расшифровано ${duration(value.processed_seconds)} из ${duration(value.total_seconds)}`
        : "Подготавливаем звук встречи…"}. Можно закрыть вкладку.
    </div>}
    {value.status === "ready" && <div className={r.meta}>Расшифровка готова · может содержать ошибки</div>}
    {value.text && <>
      <div className={r.actions}>
        <button type="button" className={r.secondary} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Свернуть текст" : "Показать расшифровку"}
        </button>
        <button type="button" className={r.secondary} onClick={download}>⬇ Текст .txt</button>
      </div>
      {expanded && <div className={r.transcriptText}>{value.text}</div>}
    </>}
    {value.status === "ready" && !value.text && <div className={r.meta}>Речь не обнаружена</div>}
    {value.error && <div className={r.error} role="alert">{value.error}</div>}
    {value.status === "failed" && value.processed_seconds > 0 && <div className={r.hint}>
      Полученный текст сохранён. Продолжение начнётся с {duration(value.processed_seconds)}.
    </div>}
    {value.enabled && !processing && value.status !== "ready" && (consent ? <>
      <div className={r.meta}>Звук встречи будет отправлен в Cloudflare. Текст сохранится рядом с записью
        и будет доступен тем, кто может открыть её звук. Расходуются минуты того, кто запускает обработку.</div>
      <div className={r.actions}>
        <button type="button" className={r.primary} disabled={busy} onClick={() => void start()}>Отправить и расшифровать</button>
        <button type="button" className={r.secondary} onClick={() => setConsent(false)}>Отмена</button>
      </div>
    </> : <button type="button" className={r.secondary} disabled={busy} onClick={() => setConsent(true)}>
      {busy ? "Запускаем…" : value.status === "failed" ? "Продолжить расшифровку" : "Расшифровать встречу"}
    </button>)}
    {error && <div className={r.error} role="alert">{error}</div>}
  </div>;
}

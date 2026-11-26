import { useState } from "react";
import { starsApi, type StarFile, type StarMessage } from "../../api/stars";
import { formatSize } from "../../attachments/file";
import { apiError } from "./rules";
import { keptUntil, recordingWhen, RETENTION_DAYS } from "./recordingText";
import r from "./RecordingCard.module.css";
import RecordingTranscript from "./RecordingTranscript";

/** Скачать файл записи по ссылке на час (без загрузки сотен мегабайт в память вкладки). */
async function download(starId: string, file: StarFile) {
  const a = document.createElement("a");
  a.href = await starsApi.fileLink(starId, file.id);
  a.download = file.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Запись встречи в чате комнаты: посмотреть, скачать видео или только звук. */
export default function RecordingCard({ message }: { message: StarMessage }) {
  const rec = message.recording!;
  const [video, setVideo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(apiError(err, "Не получилось открыть запись"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={r.card}>
      <div className={r.title}>🎥 Запись встречи</div>
      <div className={r.meta}>{recordingWhen(rec)}</div>
      {rec.status === "expired" ? (
        <div className={r.meta}>Файлы удалены: записи хранятся {RETENTION_DAYS} дней</div>
      ) : rec.status === "empty" ? (
        <div className={r.meta}>Ничего не записалось</div>
      ) : rec.status === "recording" ? (
        <div className={r.meta}>Запись ещё идёт</div>
      ) : (
        <>
          {video && (
            <video className={r.player} src={video} controls autoPlay playsInline preload="metadata" />
          )}
          <div className={r.actions}>
            {rec.video && !video && (
              <button
                type="button"
                className={r.primary}
                disabled={busy}
                onClick={() => void run(async () => setVideo(await starsApi.fileLink(message.star_id, rec.video!.id)))}
              >
                ▶ Смотреть
              </button>
            )}
            {rec.video && (
              <button type="button" className={r.secondary} disabled={busy}
                onClick={() => void run(() => download(message.star_id, rec.video!))}>
                ⬇ Видео · {formatSize(rec.video.size)}
              </button>
            )}
            {rec.audio && (
              <button type="button" className={r.secondary} disabled={busy}
                onClick={() => void run(() => download(message.star_id, rec.audio!))}>
                ⬇ Звук · {formatSize(rec.audio.size)}
              </button>
            )}
          </div>
          <div className={r.hint}>Хранится {keptUntil(rec.started_at)}</div>
          {rec.audio && <RecordingTranscript key={`${message.star_id}:${rec.id}`}
            starId={message.star_id} recordingId={rec.id} />}
        </>
      )}
      {error && <div className={r.error}>{error}</div>}
    </div>
  );
}

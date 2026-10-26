import { useState } from "react";
import { isAxiosError } from "axios";
import { fileIcon, formatSize } from "../../attachments/file";
import s from "./FileCard.module.css";

interface Props {
  name: string;
  size: number;
  /** Скачать и отдать браузеру «Сохранить как». */
  onDownload: () => Promise<void>;
  /** Что писать, если файла на сервере уже нет (404). */
  goneText?: string;
  tone?: "own" | "other";
}

/** Карточка файла в сообщении: значок, название, размер, «Скачать». */
export default function FileCard({ name, size, onDownload, goneText = "Файл удалён", tone = "other" }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDownload();
    } catch (err) {
      setError(isAxiosError(err) && err.response?.status === 404 ? goneText : "Не удалось скачать");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={tone === "own" ? `${s.card} ${s.own}` : s.card}
      onClick={() => void download()}
      title={`Скачать «${name}»`}
      aria-label={`Скачать файл ${name}`}
    >
      <span className={s.icon} aria-hidden>
        {busy ? <span className={s.spinner} /> : fileIcon(name)}
      </span>
      <span className={s.main}>
        <span className={s.name}>{name}</span>
        <span className={error ? `${s.meta} ${s.error}` : s.meta}>
          {error ?? `${formatSize(size)} · ${busy ? "скачиваем…" : "скачать"}`}
        </span>
      </span>
    </button>
  );
}

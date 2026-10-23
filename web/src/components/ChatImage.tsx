import { useEffect, useState } from "react";
import { isAxiosError } from "axios";
import { createPortal } from "react-dom";
import { fitSize, type ImageRef } from "../attachments/image";
import { loadImageUrl } from "../attachments/cache";
import s from "./ChatImage.module.css";

const MAX_W = 320;
const MAX_H = 360;

interface Props {
  chatId: string;
  image: ImageRef;
}

/** Картинка из сообщения: скачивает шифротекст, расшифровывает, по клику — на весь экран. */
export default function ChatImage({ chatId, image }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<"expired" | "error" | null>(null);
  const [open, setOpen] = useState(false);
  const box = fitSize(image.w, image.h, MAX_W, MAX_H);

  useEffect(() => {
    let alive = true;
    setFailed(null);
    loadImageUrl(chatId, image)
      .then((u) => alive && setUrl(u))
      .catch((err) => {
        // 404 — сервер удалил картинку по сроку хранения (30 дней).
        if (alive) setFailed(isAxiosError(err) && err.response?.status === 404 ? "expired" : "error");
      });
    return () => {
      alive = false;
    };
  }, [chatId, image.id, image.key]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (failed) {
    return (
      <div className={s.failed} style={{ width: box.width, height: Math.min(box.height, 120) }}>
        {failed === "expired" ? "Фото удалено — они хранятся 30 дней" : "Картинка недоступна"}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={s.thumb}
        style={{ width: box.width, height: box.height }}
        onClick={() => url && setOpen(true)}
        aria-label="Открыть картинку"
        disabled={!url}
      >
        {url ? <img src={url} alt="" className={s.img} /> : <span className={s.spinner} />}
      </button>
      {open &&
        url &&
        createPortal(
          <div className={s.lightbox} onClick={() => setOpen(false)} role="dialog" aria-label="Картинка">
            <img src={url} alt="" className={s.full} />
          </div>,
          document.body
        )}
    </>
  );
}

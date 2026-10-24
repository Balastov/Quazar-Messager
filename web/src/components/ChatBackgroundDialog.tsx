import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadImageUrl } from "../attachments/cache";
import { AttachmentError } from "../attachments/image";
import { E2EError } from "../crypto/errors";
import { useChatStore } from "../store/chat";
import s from "./ChatBackgroundDialog.module.css";

interface Props {
  chatId: string;
  isDirect: boolean;
  peerName: string;
  onClose: () => void;
}

/** Общий фон чата: ставит любой участник, меняется сразу у всех. */
export default function ChatBackgroundDialog({ chatId, isDirect, peerName, onClose }: Props) {
  const background = useChatStore((st) => st.backgrounds[chatId]);
  const setChatBackground = useChatStore((st) => st.setChatBackground);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreview(null);
    if (!background) return;
    let alive = true;
    loadImageUrl(chatId, background)
      .then((url) => alive && setPreview(url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId, background]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = async (file: File | null) => {
    setBusy(true);
    setError(null);
    try {
      await setChatBackground(chatId, file);
    } catch (err) {
      setError(
        err instanceof AttachmentError || err instanceof E2EError
          ? err.message
          : "Не удалось сменить фон"
      );
    } finally {
      setBusy(false);
    }
  };

  // В портале: стеклянные панели с backdrop-filter запирают position: fixed внутри себя.
  return createPortal(
    <div className={s.overlay} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Фон чата">
        <div className={s.header}>
          <h3 className={s.title}>Фон чата</h3>
          <button type="button" className={s.close} onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <div
          className={s.preview}
          style={preview ? { backgroundImage: `url(${JSON.stringify(preview)})` } : undefined}
        >
          {!background && <span className={s.previewText}>Сейчас — ваш фон приложения</span>}
        </div>

        <p className={s.hint}>
          {isDirect
            ? `Фон общий: ${peerName} увидит его сразу. Картинка зашифрована, как и сообщения.`
            : "Фон общий: его сразу увидят все участники группы."}
        </p>
        {error && <p className={s.error}>{error}</p>}

        <div className={s.actions}>
          <button
            type="button"
            className={s.primary}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? "Сохраняем…" : background ? "Выбрать другую картинку" : "Выбрать картинку"}
          </button>
          {background && (
            <button type="button" className={s.secondary} disabled={busy} onClick={() => void apply(null)}>
              Убрать фон
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          aria-label="Картинка для фона чата"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void apply(file);
          }}
        />
      </div>
    </div>,
    document.body
  );
}

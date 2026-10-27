import { useEffect, useMemo, useRef, useState } from "react";
import ChatDialog from "../chat/ChatDialog";
import { useChatStore } from "../../store/chat";
import { useUiStore } from "../../store/ui";
import { AttachmentError } from "../../attachments/image";
import { apiErrorText } from "../../utils/profile";
import { KINDS, MAX_TICKET_IMAGES, TICKET_TEXT_MAX, type TicketKind } from "../../support/ticket";
import c from "../constellation/Constellation.module.css";
import s from "./Support.module.css";

const PLACEHOLDER: Record<TicketKind, string> = {
  idea: "Что хотелось бы добавить или сделать удобнее?",
  question: "Ваш вопрос",
  bug: "Что случилось и как это повторить? На каком устройстве и в каком браузере?",
};

/**
 * «Обратная связь»: предложение, вопрос или ошибка — команде Квазара. Обращение приходит
 * карточкой в чат с Quazar_Admin_bot, туда же — ответы и смена статуса.
 */
export default function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const createTicket = useChatStore((st) => st.createTicket);
  const [kind, setKind] = useState<TicketKind>("idea");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const addFiles = (list: File[]) => {
    const images = list.filter((f) => f.type.startsWith("image/"));
    if (list.length && !images.length) {
      setError("Можно прикрепить только картинки: JPEG, PNG, GIF или WebP");
      return;
    }
    setError(null);
    setFiles((prev) => {
      const next = [...prev, ...images];
      if (next.length > MAX_TICKET_IMAGES) setError(`Не больше ${MAX_TICKET_IMAGES} картинок`);
      return next.slice(0, MAX_TICKET_IMAGES);
    });
  };

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ticket = await createTicket(kind, text.trim(), files);
      onClose();
      // Сразу в чат с ботом: там карточка обращения и ответ.
      const ui = useUiStore.getState();
      ui.setTab("chats");
      await useChatStore.getState().selectChat(ticket.chat_id);
      ui.setMobileChatOpen(true);
    } catch (err) {
      setError(err instanceof AttachmentError ? err.message : apiErrorText(err, "Не удалось отправить — попробуйте ещё раз"));
      setBusy(false);
    }
  };

  return (
    <ChatDialog title="Обратная связь" onClose={onClose}>
      <div
        className={dragging ? `${s.form} ${s.formDrag}` : s.form}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            addFiles(pasted);
          }
        }}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <p className={s.intro}>
          Расскажите команде Квазара, что улучшить, о чём спросить или что сломалось. Ответим в чате с{" "}
          <b>Quazar_Admin_bot</b>.
        </p>
        <div className={s.kinds} role="radiogroup" aria-label="Тип обращения">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="radio"
              aria-checked={kind === k.value}
              className={kind === k.value ? `${s.kind} ${s.kindOn}` : s.kind}
              onClick={() => setKind(k.value)}
              title={k.hint}
            >
              <span className={s.kindIcon} aria-hidden>
                {k.icon}
              </span>
              {k.label}
            </button>
          ))}
        </div>
        <textarea
          className={`${c.input} ${s.textarea}`}
          placeholder={PLACEHOLDER[kind]}
          maxLength={TICKET_TEXT_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          autoFocus
        />
        <div className={s.images}>
          {previews.map((url, i) => (
            <div key={url} className={s.thumb}>
              <img src={url} alt="" />
              <button
                type="button"
                className={s.thumbRemove}
                aria-label="Убрать картинку"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          {files.length < MAX_TICKET_IMAGES && (
            <button type="button" className={s.addImage} onClick={() => fileInputRef.current?.click()}>
              <span aria-hidden>＋</span> Картинка
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            hidden
            aria-label="Картинки к обращению"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        <p className={s.note}>
          До {MAX_TICKET_IMAGES} картинок — можно вставить скриншот (Ctrl+V) или перетащить. Картинки хранятся 30 дней.
          Обращения читает команда Квазара, сквозного шифрования здесь нет — не присылайте пароли и коды.
        </p>
        {error && <div className={c.error}>{error}</div>}
        <div className={c.row} style={{ justifyContent: "flex-end" }}>
          <button type="button" className={c.secondary} onClick={onClose}>
            Отмена
          </button>
          <button type="button" className={c.primary} disabled={busy || !text.trim()} onClick={() => void submit()}>
            {busy ? "Отправляем…" : "Отправить"}
          </button>
        </div>
      </div>
    </ChatDialog>
  );
}

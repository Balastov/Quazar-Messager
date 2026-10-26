import { useEffect, useState } from "react";
import ChatDialog from "../chat/ChatDialog";
import s from "./PinBar.module.css";

export interface PinItem {
  id: string;
  author: string;
  text: string;
}

/**
 * Полоса закреплённых над лентой: нажатие — к сообщению, следующее нажатие — к более старому
 * закрепу (как в Telegram). «Все» — список с «Открепить».
 */
export default function PinBar({
  items,
  onOpen,
  onUnpin,
}: {
  /** Свежие первыми. */
  items: PinItem[];
  onOpen: (id: string) => void;
  /** Нет — открепить нельзя (нет прав). */
  onUnpin?: (id: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const count = items.length;

  useEffect(() => setIndex(0), [count]);

  if (!count) return null;
  const current = items[Math.min(index, count - 1)];

  return (
    <>
      <div className={s.bar}>
        <button
          type="button"
          className={s.main}
          onClick={() => {
            onOpen(current.id);
            setIndex((i) => (i + 1) % count);
          }}
          title="Показать в ленте"
        >
          <span className={s.marks} aria-hidden>
            {items.slice(0, 4).map((it, i) => (
              <span key={it.id} className={i === Math.min(index, count - 1) ? s.markOn : s.mark} />
            ))}
          </span>
          <span className={s.texts}>
            <span className={s.label}>
              📌 Закреплено{count > 1 ? ` · ${Math.min(index, count - 1) + 1} из ${count}` : ""}
            </span>
            <span className={s.preview}>
              <b>{current.author}:</b> {current.text}
            </span>
          </span>
        </button>
        <button type="button" className={s.all} onClick={() => setListOpen(true)} aria-label="Все закреплённые" title="Все закреплённые">
          ☰
        </button>
      </div>
      {listOpen && (
        <ChatDialog title="Закреплённые" onClose={() => setListOpen(false)}>
          <div className={s.list}>
            {items.map((it) => (
              <div key={it.id} className={s.item}>
                <button
                  type="button"
                  className={s.itemMain}
                  onClick={() => {
                    setListOpen(false);
                    onOpen(it.id);
                  }}
                >
                  <b>{it.author}</b>
                  <span>{it.text}</span>
                </button>
                {onUnpin && (
                  <button type="button" className={s.unpin} onClick={() => onUnpin(it.id)}>
                    Открепить
                  </button>
                )}
              </div>
            ))}
          </div>
        </ChatDialog>
      )}
    </>
  );
}

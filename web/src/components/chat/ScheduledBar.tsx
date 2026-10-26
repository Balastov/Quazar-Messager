import { useEffect, useState } from "react";
import { useChatStore, type ScheduledView } from "../../store/chat";
import { formatWhen } from "../../chat/when";
import s from "./Chat.module.css";

const NONE: ScheduledView[] = [];

/** «🕓 Отложенные: 2» над полем ввода; раскрывается список с отменой. */
export default function ScheduledBar({ chatId }: { chatId: string }) {
  const items = useChatStore((st) => st.scheduled[chatId] ?? NONE);
  const loadScheduled = useChatStore((st) => st.loadScheduled);
  const cancelScheduled = useChatStore((st) => st.cancelScheduled);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
    void loadScheduled(chatId).catch(() => {});
  }, [chatId, loadScheduled]);

  if (!items.length) return null;

  return (
    <div className={s.scheduledBar}>
      <button type="button" className={s.scheduledToggle} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        🕓 Отложенные: {items.length}
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className={s.scheduledList}>
          {items.map((item) => (
            <div key={item.id} className={s.scheduledItem}>
              <span className={s.scheduledWhen}>{formatWhen(item.sendAt)}</span>
              <span className={s.scheduledText}>{item.text}</span>
              <button
                type="button"
                className={s.iconAction}
                aria-label="Не отправлять"
                title="Не отправлять"
                onClick={() => void cancelScheduled(chatId, item.id).catch(() => {})}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

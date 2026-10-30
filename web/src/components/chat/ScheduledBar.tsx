import { useEffect, useState } from "react";
import { useChatStore, type ScheduledView } from "../../store/chat";
import { formatWhen } from "../../chat/when";
import { socket } from "../../ws/socket";
import { apiError } from "../constellation/rules";
import s from "./Chat.module.css";

const NONE: ScheduledView[] = [];

/** «🕓 Отложенные: 2» над полем ввода; раскрывается список с отменой. */
export default function ScheduledBar({ chatId }: { chatId: string }) {
  const items = useChatStore((st) => st.scheduled[chatId] ?? NONE);
  const loadScheduled = useChatStore((st) => st.loadScheduled);
  const cancelScheduled = useChatStore((st) => st.cancelScheduled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => void loadScheduled(chatId).then(() => {
      if (active) setError(null);
    }).catch((err) => {
      if (active) setError(apiError(err, "Не удалось загрузить отложенные сообщения"));
    });
    setError(null);
    load();
    const off = socket.onStatus((open) => { if (open) load(); });
    return () => { active = false; off(); };
  }, [chatId, loadScheduled]);

  return <ScheduledList key={chatId} items={items} error={error} onCancel={(id) => cancelScheduled(chatId, id)} />;
}

/** Общий список личной очереди для чатов и Спутников. */
export function ScheduledList({ items, error, onCancel }: {
  items: { id: string; text: string; sendAt: string }[];
  error?: string | null;
  onCancel: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  if (!items.length && !error && !cancelError) return null;

  const cancel = async (id: string) => {
    setPending(id);
    setCancelError(null);
    try {
      await onCancel(id);
    } catch (err) {
      setCancelError(apiError(err, "Не удалось отменить отправку"));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={s.scheduledBar}>
      {!!items.length && <button type="button" className={s.scheduledToggle} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        🕓 Отложенные: {items.length}
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>}
      {(error || cancelError) && <div role="alert" className={s.scheduledError}>{error || cancelError}</div>}
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
                disabled={pending !== null}
                onClick={() => void cancel(item.id)}
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

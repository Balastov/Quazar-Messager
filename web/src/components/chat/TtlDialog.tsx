import { useState } from "react";
import type { Chat } from "../../api/types";
import { TTL_OPTIONS } from "../../chat/ttl";
import { useChatStore } from "../../store/chat";
import ChatDialog from "./ChatDialog";
import c from "../constellation/Constellation.module.css";
import s from "./Chat.module.css";

/** Исчезающие сообщения: выключено / 1 час / 1 день / 1 неделя. */
export default function TtlDialog({ chat, canChange, onClose }: { chat: Chat; canChange: boolean; onClose: () => void }) {
  const setChatTtl = useChatStore((st) => st.setChatTtl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = chat.ttl_seconds ?? null;

  const pick = async (value: number | null) => {
    if (value === current) return onClose();
    setBusy(true);
    setError(null);
    try {
      await setChatTtl(chat.id, value);
      onClose();
    } catch {
      setError("Не удалось изменить — попробуйте ещё раз");
      setBusy(false);
    }
  };

  return (
    <ChatDialog title="Исчезающие сообщения" onClose={onClose}>
      <p className={c.hint}>
        Новые сообщения пропадут у всех через выбранное время после отправки — вместе с фото и
        голосовыми. Уже отправленные останутся.
        {chat.type === "direct" ? " Срок меняет любой из вас двоих." : ""}
      </p>
      {!canChange && <p className={`${c.hint} ${c.warn}`}>Менять могут владелец и админы группы.</p>}
      <div className={s.options}>
        {TTL_OPTIONS.map((o) => (
          <button
            key={o.label}
            type="button"
            className={o.value === current ? s.optionActive : s.option}
            disabled={busy || !canChange}
            onClick={() => void pick(o.value)}
          >
            {o.value ? `⏱ ${o.label}` : o.label}
            {o.value === current && <span className={s.optionHint}>сейчас</span>}
          </button>
        ))}
      </div>
      {error && <div className={c.error}>{error}</div>}
    </ChatDialog>
  );
}

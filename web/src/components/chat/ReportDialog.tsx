import { useState } from "react";
import type { ReportReason } from "../../api/users";
import { isUnreadable, useChatStore } from "../../store/chat";
import { messagePreview } from "../../store/stickers";
import { useBlocksStore } from "../../store/blocks";
import { notifyInfo } from "../../notifications/notify";
import ChatDialog from "./ChatDialog";
import c from "../constellation/Constellation.module.css";
import s from "./Chat.module.css";

const REASONS: { value: ReportReason; label: string }[] = [
  { value: "spam", label: "Спам или реклама" },
  { value: "abuse", label: "Оскорбления, угрозы, травля" },
  { value: "fraud", label: "Мошенничество" },
  { value: "other", label: "Другое" },
];

/** Сколько последних сообщений собеседника можно приложить. */
const EVIDENCE = 5;

interface Props {
  userId: string;
  username: string;
  chatId: string | null;
  onClose: () => void;
}

/**
 * Жалоба. Переписка зашифрована, сервер её не видит, — поэтому последние сообщения
 * прикладываются, только если человек сам это отметил.
 */
export default function ReportDialog({ userId, username, chatId, onClose }: Props) {
  const report = useBlocksStore((st) => st.report);
  const alreadyBlocked = useBlocksStore((st) => st.ids.includes(userId));
  const messages = useChatStore((st) => (chatId ? st.messages[chatId] : undefined));
  const [reason, setReason] = useState<ReportReason>("spam");
  const [comment, setComment] = useState("");
  const [attach, setAttach] = useState(true);
  const [block, setBlock] = useState(!alreadyBlocked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const evidence = (messages ?? [])
    .filter((m) => m.sender_id === userId && !isUnreadable(m.payload))
    .slice(-EVIDENCE)
    .map((m) => ({ sender: "them" as const, at: m.created_at, text: messagePreview(m.payload).slice(0, 4000) }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await report(userId, {
        reason,
        comment: comment.trim() || undefined,
        chat_id: chatId ?? undefined,
        evidence: attach ? evidence : [],
        block: block && !alreadyBlocked,
      });
      notifyInfo({ title: "Жалоба отправлена", body: block ? `${username} заблокирован(а)` : "Спасибо, мы разберёмся" });
      onClose();
    } catch {
      setError("Не удалось отправить жалобу — попробуйте позже");
      setBusy(false);
    }
  };

  return (
    <ChatDialog title={`Пожаловаться на ${username}`} onClose={onClose}>
      <div className={s.options} role="radiogroup" aria-label="Причина">
        {REASONS.map((r) => (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={reason === r.value}
            className={reason === r.value ? s.optionActive : s.option}
            onClick={() => setReason(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <textarea
        className={`${c.input} ${s.textarea}`}
        placeholder="Подробности (необязательно)"
        maxLength={2000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      {evidence.length > 0 && (
        <label className={s.check}>
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          <span>
            Приложить последние сообщения {username} ({evidence.length}). Переписка зашифрована —
            без этого её никто не увидит.
          </span>
        </label>
      )}
      {!alreadyBlocked && (
        <label className={s.check}>
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
          <span>Заблокировать — сообщения и звонки от {username} перестанут приходить</span>
        </label>
      )}
      {error && <div className={c.error}>{error}</div>}
      <div className={c.row} style={{ justifyContent: "flex-end" }}>
        <button type="button" className={c.secondary} onClick={onClose}>
          Отмена
        </button>
        <button type="button" className={c.danger} disabled={busy} onClick={() => void submit()}>
          Отправить жалобу
        </button>
      </div>
    </ChatDialog>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StarChannel, StarDetail, StarMessage } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import UserAvatar from "../UserAvatar";
import { IconBack, IconGear, IconSatellite, IconSend } from "../icons";
import { apiError, can, formatTime, outranks } from "./rules";
import s from "./Constellation.module.css";

const EMPTY: StarMessage[] = [];

interface Props {
  detail: StarDetail;
  channel: StarChannel;
  onBack?: () => void;
  onEdit: () => void;
}

export default function SatelliteView({ detail, channel, onBack, onEdit }: Props) {
  const myId = useAuthStore((st) => st.user?.id);
  const messages = useStarsStore((st) => st.messages[channel.id] ?? EMPTY);
  const hasMore = useStarsStore((st) => st.hasMore[channel.id] ?? false);
  const loading = useStarsStore((st) => st.loadingMessages);
  const sendMessage = useStarsStore((st) => st.sendMessage);
  const deleteMessage = useStarsStore((st) => st.deleteMessage);
  const loadOlder = useStarsStore((st) => st.loadOlder);

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const roleOf = (userId: string) => detail.members.find((m) => m.user.id === userId)?.role;

  const canDelete = (m: StarMessage) => {
    if (m.sender?.id === myId) return true;
    if (!can(detail, "delete_messages")) return false;
    const senderRole = m.sender ? roleOf(m.sender.id) : undefined;
    return !senderRole || outranks(detail.my_role, senderRole);
  };

  useEffect(() => {
    stickToBottom.current = true;
    setError(null);
  }, [channel.id]);

  // Новые сообщения прокручиваем вниз, только если человек и так был внизу.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, channel.id]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    setError(null);
    stickToBottom.current = true;
    try {
      await sendMessage(value);
    } catch (err) {
      setText(value);
      setError(apiError(err, "Не удалось отправить сообщение"));
    }
  };

  return (
    <>
      <div className={s.channelHeader}>
        {onBack && (
          <button type="button" className={s.iconBtn} onClick={onBack} aria-label="Назад">
            <IconBack />
          </button>
        )}
        <IconSatellite />
        <div className={s.channelTitle}>
          <span className={s.channelTitleName}>{channel.name}</span>
          <span className={s.channelTitleSub}>Спутник · {detail.name} · без сквозного шифрования</span>
        </div>
        {can(detail, "manage_channels") && (
          <button
            type="button"
            className={s.iconBtn}
            onClick={onEdit}
            aria-label="Изменить Спутник"
            title="Изменить Спутник"
          >
            <IconGear />
          </button>
        )}
      </div>

      <div className={s.messages} ref={listRef} onScroll={onScroll}>
        {hasMore && (
          <button
            type="button"
            className={`${s.secondary} ${s.small} ${s.loadOlder}`}
            onClick={() => {
              stickToBottom.current = false;
              void loadOlder(channel.id);
            }}
          >
            Показать более ранние
          </button>
        )}
        {loading && messages.length === 0 && <div className={s.empty}>Загрузка…</div>}
        {!loading && messages.length === 0 && (
          <div className={s.empty}>
            <div className={s.emptyTitle}>Здесь пока тихо</div>
            Напишите первое сообщение — его увидят все участники Звезды.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={s.message}>
            <UserAvatar
              username={m.sender?.username ?? "?"}
              avatarUrl={m.sender?.avatar_url ?? null}
              size="sm"
            />
            <div className={s.messageBody}>
              <div className={s.messageHead}>
                <span className={s.messageAuthor}>{m.sender?.username ?? "Бывший участник"}</span>
                <span className={s.messageTime}>{formatTime(m.created_at)}</span>
              </div>
              <div className={s.messageText}>{m.text}</div>
            </div>
            {canDelete(m) && (
              <button
                type="button"
                className={s.messageDelete}
                aria-label="Удалить сообщение"
                title="Удалить сообщение"
                onClick={() => {
                  if (window.confirm("Удалить это сообщение для всех?")) {
                    void deleteMessage(m).catch((err) => setError(apiError(err)));
                  }
                }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className={s.error} style={{ padding: "6px 16px" }}>
          {error}
        </div>
      )}
      <form className={s.composer} onSubmit={(e) => void submit(e)}>
        <input
          className={s.composerInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Написать в «${channel.name}»`}
          maxLength={4000}
          aria-label="Сообщение"
        />
        <button
          type="submit"
          className={s.primary}
          disabled={!text.trim()}
          aria-label="Отправить"
          style={{ padding: "0 16px" }}
        >
          <IconSend size={18} />
        </button>
      </form>
    </>
  );
}

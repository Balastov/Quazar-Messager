import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat";
import { useAuthStore } from "../store/auth";
import { E2EError } from "../crypto/errors";
import s from "./MessageView.module.css";

export default function MessageView() {
  const {
    activeChatId,
    chats,
    messages,
    loadingMessages,
    sendMessage,
    e2eReady,
    e2eError,
    showMigrationNotice,
    dismissMigrationNotice,
  } = useChatStore();
  const currentUser = useAuthStore((st) => st.user);
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const chat = chats.find((c) => c.id === activeChatId);
  const msgs = activeChatId ? (messages[activeChatId] ?? []) : [];
  const isDirect = chat?.type === "direct";
  const inputDisabled = isDirect && e2eReady === false;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  useEffect(() => {
    setSendError(null);
  }, [activeChatId]);

  if (!activeChatId) {
    return (
      <div className={s.empty}>
        <p>Выберите чат или найдите пользователя</p>
      </div>
    );
  }

  const chatTitle = () => {
    if (!chat) return "";
    if (chat.type === "group") return chat.name ?? "Группа";
    const other = chat.members.find((m) => m.user.id !== currentUser?.id);
    return other?.user.username ?? "";
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = text.trim();
    if (!payload || !activeChatId || inputDisabled) return;
    setText("");
    setSendError(null);
    try {
      await sendMessage(activeChatId, payload);
    } catch (err) {
      if (err instanceof E2EError) {
        setSendError(err.message);
      } else {
        setSendError("Не удалось отправить сообщение");
      }
      setText(payload);
    }
  };

  const statusIcon = (status: string) => {
    if (status === "read") return "✓✓";
    if (status === "delivered") return "✓✓";
    return "✓";
  };

  const e2eLockClass = () => {
    if (!isDirect) return s.e2eOpen;
    if (e2eReady) return s.e2eSecure;
    return s.e2eWarning;
  };

  const e2eTitle = () => {
    if (!isDirect) return "Групповой чат без end-to-end шифрования";
    if (e2eReady) return "Сообщения защищены end-to-end шифрованием";
    return e2eError ?? "Шифрование недоступно";
  };

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.avatar}>{chatTitle()[0]?.toUpperCase()}</span>
        <div className={s.headerInfo}>
          <span className={s.name}>{chatTitle()}</span>
          {isDirect && (
            <span className={`${s.e2eBadge} ${e2eLockClass()}`} title={e2eTitle()}>
              🔒 {e2eReady ? "E2E" : "E2E недоступно"}
            </span>
          )}
          {chat?.type === "group" && (
            <span className={`${s.e2eBadge} ${s.e2eOpen}`} title={e2eTitle()}>
              🔓 без E2E
            </span>
          )}
        </div>
      </div>

      {showMigrationNotice && (
        <div className={s.bannerInfo}>
          Ключи шифрования обновлены. Старые зашифрованные сообщения могут не расшифроваться.
          <button type="button" className={s.bannerDismiss} onClick={dismissMigrationNotice}>
            ✕
          </button>
        </div>
      )}

      {isDirect && e2eReady === false && e2eError && (
        <div className={s.bannerWarning}>{e2eError}</div>
      )}

      {sendError && <div className={s.bannerWarning}>{sendError}</div>}

      <div className={s.messages}>
        {loadingMessages && <div className={s.hint}>Загрузка...</div>}
        {msgs.map((msg) => {
          const isOwn = msg.sender_id === currentUser?.id;
          return (
            <div key={msg.id} className={isOwn ? s.ownBubble : s.otherBubble}>
              <span className={s.text}>{msg.payload}</span>
              <span className={s.meta}>
                {new Date(msg.created_at).toLocaleTimeString("ru", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {isOwn && <span className={s.status}>{statusIcon(msg.status)}</span>}
              </span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className={s.input} onSubmit={handleSend}>
        <input
          className={s.textInput}
          placeholder={
            inputDisabled
              ? "Ожидание ключей шифрования..."
              : "Написать сообщение..."
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend(e)}
          disabled={inputDisabled}
        />
        <button className={s.send} type="submit" disabled={!text.trim() || inputDisabled}>
          ➤
        </button>
      </form>
    </div>
  );
}

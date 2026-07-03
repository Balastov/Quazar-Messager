import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat";
import { useAuthStore } from "../store/auth";
import { E2EError } from "../crypto/errors";
import E2EStatusPanel from "./E2EStatusPanel";
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
    e2eTrust,
    peerFingerprint,
    showE2ePanel,
    showMigrationNotice,
    dismissMigrationNotice,
    setShowE2ePanel,
    verifyActivePeer,
    acceptActivePeerKey,
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
    if (e2eTrust === "ok") return s.e2eSecure;
    if (e2eTrust === "changed") return s.e2eDanger;
    if (e2eReady) return s.e2ePending;
    return s.e2eWarning;
  };

  const e2eBadgeText = () => {
    if (!isDirect) return "";
    if (e2eTrust === "ok") return "🔒 E2E проверен";
    if (e2eTrust === "changed") return "🔒 ключ изменился";
    if (e2eTrust === "new" || e2eTrust === "unverified") return "🔒 E2E";
    if (e2eReady) return "🔒 E2E";
    return "🔒 E2E недоступно";
  };

  const e2eTitle = () => {
    if (!isDirect) return "Групповой чат без end-to-end шифрования";
    if (e2eTrust === "ok") return "Ключ собеседника проверен";
    if (e2eTrust === "changed") return "Ключ собеседника изменился — требуется подтверждение";
    if (e2eTrust === "new" || e2eTrust === "unverified") {
      return "Шифрование активно. Рекомендуется проверить код безопасности.";
    }
    if (e2eReady) return "Сообщения защищены end-to-end шифрованием";
    return e2eError ?? "Шифрование недоступно";
  };

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.avatar}>{chatTitle()[0]?.toUpperCase()}</span>
        <div className={s.headerInfo}>
          <span className={s.name}>{chatTitle()}</span>
          <div className={s.headerActions}>
            {isDirect && (
              <>
                <button
                  type="button"
                  className={`${s.e2eBadge} ${e2eLockClass()}`}
                  title={e2eTitle()}
                  onClick={() => setShowE2ePanel(true)}
                >
                  {e2eBadgeText()}
                </button>
                {(e2eTrust === "new" ||
                  e2eTrust === "unverified" ||
                  e2eTrust === "changed") && (
                  <button
                    type="button"
                    className={s.verifyBtn}
                    onClick={() => setShowE2ePanel(true)}
                  >
                    {e2eTrust === "changed" ? "Подтвердить ключ" : "Проверить"}
                  </button>
                )}
              </>
            )}
            {chat?.type === "group" && (
              <span className={`${s.e2eBadge} ${s.e2eOpen}`} title={e2eTitle()}>
                🔓 без E2E
              </span>
            )}
          </div>
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

      {isDirect && e2eTrust === "changed" && (
        <div className={s.bannerDanger}>
          Ключ собеседника изменился. Сверьте код безопасности перед продолжением переписки.
          <button type="button" className={s.bannerAction} onClick={() => setShowE2ePanel(true)}>
            Открыть
          </button>
        </div>
      )}

      {isDirect && e2eReady === false && e2eTrust !== "changed" && e2eError && (
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

      {showE2ePanel && isDirect && (
        <E2EStatusPanel
          username={chatTitle()}
          fingerprint={peerFingerprint}
          trustStatus={e2eTrust}
          onVerify={() => void verifyActivePeer()}
          onAcceptKey={() => void acceptActivePeerKey()}
          onClose={() => setShowE2ePanel(false)}
        />
      )}
    </div>
  );
}

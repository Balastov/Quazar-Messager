import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat";
import { useAuthStore } from "../store/auth";
import { useUiStore } from "../store/ui";
import { E2EError } from "../crypto/errors";
import E2EStatusPanel from "./E2EStatusPanel";
import UserAvatar from "./UserAvatar";
import {
  IconBack,
  IconMore,
  IconPhone,
  IconMic,
  IconPlus,
  IconSend,
  IconVideo,
} from "./icons";
import s from "./MessageView.module.css";

interface Props {
  showBack?: boolean;
}

export default function MessageView({ showBack = false }: Props) {
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
  const setMobileChatOpen = useUiStore((st) => st.setMobileChatOpen);
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
        {showBack && (
          <button
            type="button"
            className={s.emptyBack}
            onClick={() => setMobileChatOpen(false)}
          >
            <IconBack /> К списку чатов
          </button>
        )}
        <div className={s.emptyTitle}>Выберите чат</div>
        <p>Найдите пользователя в контактах или откройте диалог из списка</p>
      </div>
    );
  }

  const peer = (() => {
    if (!chat) return { username: "", avatar_url: null as string | null };
    if (chat.type === "group") {
      return { username: chat.name ?? "Группа", avatar_url: null };
    }
    const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
    return {
      username: other?.username ?? "",
      avatar_url: other?.avatar_url ?? null,
    };
  })();

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const payload = text.trim();
    if (!payload || !activeChatId || inputDisabled) return;
    setText("");
    setSendError(null);
    try {
      await sendMessage(activeChatId, payload);
    } catch (err) {
      if (err instanceof E2EError) setSendError(err.message);
      else setSendError("Не удалось отправить сообщение");
      setText(payload);
    }
  };

  const statusIcon = (status: string) => {
    if (status === "read" || status === "delivered") return "✓✓";
    return "✓";
  };

  const statusClass = (status: string) => {
    if (status === "read") return s.statusRead;
    if (status === "delivered") return s.statusDelivered;
    return s.statusSent;
  };

  const e2eDotClass =
    e2eTrust === "ok"
      ? s.e2eDot
      : e2eTrust === "changed"
        ? s.e2eDotDanger
        : s.e2eDotWarn;

  const subtitle = (() => {
    if (!isDirect) return "Группа · без E2E";
    if (e2eTrust === "ok") return "E2E защищён";
    if (e2eTrust === "changed") return "Ключ изменился";
    if (e2eReady) return "E2E";
    return e2eError ?? "E2E недоступно";
  })();

  return (
    <div className={s.root}>
      <div className={s.header}>
        {showBack && (
          <button
            type="button"
            className={s.back}
            onClick={() => setMobileChatOpen(false)}
            aria-label="Назад"
          >
            <IconBack />
          </button>
        )}
        <UserAvatar username={peer.username || "?"} avatarUrl={peer.avatar_url} size="sm" />
        <div className={s.headerInfo}>
          <span className={s.name}>{peer.username}</span>
          <span className={s.sub}>
            {isDirect && <span className={e2eDotClass} />}
            {subtitle}
          </span>
        </div>
        <div className={s.headerActions}>
          <button type="button" className={s.iconBtn} title="Звонки скоро">
            <IconPhone size={18} />
          </button>
          <button type="button" className={s.iconBtn} title="Видео скоро">
            <IconVideo size={18} />
          </button>
          <button
            type="button"
            className={s.iconBtn}
            title="Безопасность"
            onClick={() => setShowE2ePanel(true)}
          >
            <IconMore size={18} />
          </button>
        </div>
      </div>

      {showMigrationNotice && (
        <div className={s.bannerInfo}>
          Ключи шифрования обновлены. Старые сообщения могут не расшифроваться.
          <button type="button" className={s.bannerDismiss} onClick={dismissMigrationNotice}>
            ✕
          </button>
        </div>
      )}

      {isDirect && e2eTrust === "changed" && (
        <div className={s.bannerDanger}>
          Ключ собеседника изменился. Сверьте код безопасности.
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
          const unavailable = msg.payload.startsWith("Сообщение недоступно");
          return (
            <div key={msg.id} className={isOwn ? s.ownBubble : s.otherBubble}>
              <span className={unavailable ? s.textMuted : s.text}>{msg.payload}</span>
              <span className={s.meta}>
                {new Date(msg.created_at).toLocaleTimeString("ru", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {isOwn && (
                  <span className={statusClass(msg.status)} aria-label={msg.status}>
                    {statusIcon(msg.status)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className={s.composer} onSubmit={(e) => void handleSend(e)}>
        <button type="button" className={s.attachBtn} title="Вложения скоро" disabled>
          <IconPlus size={20} />
        </button>
        <div className={s.field}>
          <input
            className={s.textInput}
            placeholder={
              inputDisabled ? "Ожидание ключей шифрования..." : "Написать сообщение..."
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={inputDisabled}
          />
        </div>
        {text.trim() ? (
          <button
            className={s.sendBtn}
            type="submit"
            disabled={!text.trim() || inputDisabled}
            aria-label="Отправить"
          >
            <IconSend size={18} />
          </button>
        ) : (
          <button className={s.micBtn} type="button" title="Голосовые скоро" disabled>
            <IconMic size={18} />
          </button>
        )}
      </form>

      {showE2ePanel && isDirect && (
        <E2EStatusPanel
          username={peer.username}
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

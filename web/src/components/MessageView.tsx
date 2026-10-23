import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat";
import { useAuthStore } from "../store/auth";
import { useUiStore } from "../store/ui";
import { useCallStore } from "../store/call";
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
  IconSticker,
  IconVideo,
} from "./icons";
import s from "./MessageView.module.css";
import { usePresence, usePresenceStore, usePresenceText } from "../store/presence";
import { presenceTone } from "../utils/presence";
import LinkifiedText from "./LinkifiedText";
import Sticker from "./Sticker";
import StickerPicker from "./StickerPicker";
import { useStickersStore } from "../store/stickers";
import { stickerFileUrl, type StickerInfo } from "../api/stickers";
import { encodeSticker, parseSticker } from "../stickers/format";
import ChatImage from "./ChatImage";
import { AttachmentError, parseImage } from "../attachments/image";

const STICKER_SIZE = 160;

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
    sendImage,
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
  const startAudioCall = useCallStore((st) => st.startAudioCall);
  const startVideoCall = useCallStore((st) => st.startVideoCall);
  const callPhase = useCallStore((st) => st.phase);
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stickersByKey = useStickersStore((st) => st.byKey);
  const stickersLoaded = useStickersStore((st) => st.loaded);
  const bottomRef = useRef<HTMLDivElement>(null);

  const chat = chats.find((c) => c.id === activeChatId);
  const msgs = activeChatId ? (messages[activeChatId] ?? []) : [];
  const isDirect = chat?.type === "direct";
  const inputDisabled = isDirect && e2eReady === false;

  useEffect(() => {
    setStickersOpen(false);
  }, [activeChatId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  useEffect(() => {
    setSendError(null);
  }, [activeChatId]);

  // Кто в сети: собеседник в личном чате, сколько участников — в группе.
  // Хуки — до раннего return ниже, иначе при открытии чата их число изменится.
  const presencePeerId =
    chat?.type === "direct"
      ? (chat.members.find((m) => m.user.id !== currentUser?.id)?.user.id ?? null)
      : null;
  const peerPresenceRaw = usePresence(presencePeerId);
  const peerStatusText = usePresenceText(presencePeerId);
  const groupOnline = usePresenceStore((st) =>
    chat?.type === "group"
      ? chat.members.filter((m) => m.user.id !== currentUser?.id && st.byId[m.user.id]?.online).length
      : 0
  );

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
    if (!chat) return { id: null as string | null, username: "", avatar_url: null as string | null };
    if (chat.type === "group") {
      return { id: null, username: chat.name ?? "Группа", avatar_url: null };
    }
    const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
    return {
      id: other?.id ?? null,
      username: other?.username ?? "",
      avatar_url: other?.avatar_url ?? null,
    };
  })();

  const callBusy = callPhase !== "idle" && callPhase !== "ended";

  const handleAudioCall = () => {
    if (!activeChatId || !peer.id || !isDirect || callBusy) return;
    void startAudioCall(activeChatId, peer.id);
  };

  const handleVideoCall = () => {
    if (!activeChatId || !peer.id || !isDirect || callBusy) return;
    void startVideoCall(activeChatId, peer.id);
  };

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

  const handleSticker = async (packId: string, sticker: StickerInfo) => {
    if (!activeChatId || inputDisabled) return;
    setStickersOpen(false);
    setSendError(null);
    try {
      await sendMessage(activeChatId, encodeSticker(packId, sticker.id));
    } catch (err) {
      if (err instanceof E2EError) setSendError(err.message);
      else setSendError("Не удалось отправить стикер");
    }
  };

  const handleImages = async (files: File[]) => {
    if (!activeChatId || inputDisabled || !files.length) return;
    setSendError(null);
    setStickersOpen(false);
    // По одной, в порядке выбора: так они и лягут в чат.
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        await sendImage(activeChatId, file);
      } catch (err) {
        if (err instanceof AttachmentError || err instanceof E2EError) setSendError(err.message);
        else setSendError("Не удалось отправить картинку");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void handleImages(files);
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

  const peerPresence = peerPresenceRaw;
  const peerStatus = peerStatusText;
  const onlineInGroup = groupOnline;

  const e2eDotClass =
    e2eTrust === "ok"
      ? s.e2eDot
      : e2eTrust === "changed"
        ? s.e2eDotDanger
        : s.e2eDotWarn;

  const subtitle = (() => {
    if (!isDirect) {
      return onlineInGroup > 0 ? `Группа · ${onlineInGroup} в сети · без E2E` : "Группа · без E2E";
    }
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
        <UserAvatar username={peer.username || "?"} avatarUrl={peer.avatar_url} size="sm" userId={peer.id} />
        <div className={s.headerInfo}>
          <span className={s.name}>{peer.username}</span>
          <span className={s.sub}>
            {isDirect && peerStatus && (
              <span
                className={
                  { online: s.presenceOnline, away: s.presenceAway, busy: s.presenceBusy, none: "" }[
                    presenceTone(peerPresence) ?? "none"
                  ]
                }
              >
                {peerStatus} ·{" "}
              </span>
            )}
            {isDirect && <span className={e2eDotClass} />}
            {subtitle}
          </span>
        </div>
        <div className={s.headerActions}>
          <button
            type="button"
            className={s.iconBtn}
            title={isDirect ? "Аудиозвонок" : "Звонки только в личных чатах"}
            disabled={!isDirect || !peer.id || callBusy}
            onClick={handleAudioCall}
          >
            <IconPhone size={18} />
          </button>
          <button
            type="button"
            className={s.iconBtn}
            title={isDirect ? "Видеозвонок" : "Звонки только в личных чатах"}
            disabled={!isDirect || !peer.id || callBusy}
            onClick={handleVideoCall}
          >
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
          const image = unavailable ? null : parseImage(msg.payload);
          const stickerRef = unavailable ? null : parseSticker(msg.payload);
          const sticker = stickerRef ? stickersByKey[`${stickerRef.pack}/${stickerRef.id}`] : undefined;
          // Стикер без пузыря; неизвестный (пак убрали с сервера) — обычной строкой.
          const asSticker = !!stickerRef && (!!sticker || !stickersLoaded);
          return (
            <div
              key={msg.id}
              className={
                asSticker
                  ? isOwn ? s.ownSticker : s.otherSticker
                  : `${isOwn ? s.ownBubble : s.otherBubble}${image ? ` ${s.imageBubble}` : ""}`
              }
            >
              {image ? (
                <ChatImage chatId={msg.chat_id} image={image} />
              ) : asSticker ? (
                sticker ? (
                  <Sticker url={stickerFileUrl(sticker)} emoji={sticker.emoji} size={STICKER_SIZE} mode="loop" />
                ) : (
                  <div style={{ width: STICKER_SIZE, height: STICKER_SIZE }} />
                )
              ) : stickerRef ? (
                <span className={s.textMuted}>Стикер недоступен</span>
              ) : (
                <span className={unavailable ? s.textMuted : s.text}>
                  {unavailable ? msg.payload : <LinkifiedText text={msg.payload} linkClassName={s.link} />}
                </span>
              )}
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
        {uploading > 0 && (
          <div className={s.hint}>
            {uploading > 1 ? `Отправка картинок: ${uploading}…` : "Отправка картинки…"}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className={s.composerWrap}>
      {stickersOpen && (
        <StickerPicker
          onPick={(packId, st) => void handleSticker(packId, st)}
          onClose={() => setStickersOpen(false)}
        />
      )}
      <form className={s.composer} onSubmit={(e) => void handleSend(e)}>
        <button
          type="button"
          className={s.attachBtn}
          title="Фото"
          aria-label="Отправить картинку"
          onClick={() => fileInputRef.current?.click()}
          disabled={inputDisabled}
        >
          <IconPlus size={20} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void handleImages(files);
          }}
        />
        <div className={s.field}>
          <input
            className={s.textInput}
            placeholder={
              inputDisabled ? "Ожидание ключей шифрования..." : "Написать сообщение..."
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            disabled={inputDisabled}
          />
          <button
            type="button"
            className={stickersOpen ? s.stickerBtnActive : s.stickerBtn}
            onClick={() => setStickersOpen((open) => !open)}
            disabled={inputDisabled}
            aria-label="Стикеры"
            aria-expanded={stickersOpen}
            title="Стикеры"
            data-sticker-toggle
          >
            <IconSticker size={20} />
          </button>
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
      </div>

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

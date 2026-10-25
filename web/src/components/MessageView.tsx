import { useCallback, useEffect, useRef, useState } from "react";
import { isUnreadable, useChatStore } from "../store/chat";
import { useAuthStore } from "../store/auth";
import { useUiStore } from "../store/ui";
import { useCallStore } from "../store/call";
import { E2EError } from "../crypto/errors";
import E2EStatusPanel from "./E2EStatusPanel";
import UserAvatar from "./UserAvatar";
import {
  IconBack,
  IconImage,
  IconMore,
  IconPhone,
  IconMic,
  IconPlus,
  IconSend,
  IconSticker,
  IconVideo,
} from "./icons";
import s from "./MessageView.module.css";
import m from "./messages/Messages.module.css";
import { usePresence, usePresenceStore, usePresenceText } from "../store/presence";
import { presenceTone } from "../utils/presence";
import LinkifiedText from "./LinkifiedText";
import Sticker from "./Sticker";
import StickerPicker from "./StickerPicker";
import { messagePreview, useStickersStore } from "../store/stickers";
import { stickerFileUrl, type StickerInfo } from "../api/stickers";
import { encodeSticker, parseSticker } from "../stickers/format";
import ChatImage from "./ChatImage";
import ChatBackgroundDialog from "./ChatBackgroundDialog";
import { AttachmentError, parseImage } from "../attachments/image";
import type { Message } from "../api/types";
import { groupReactions, myReaction, toggledReaction } from "../chat/reactions";
import { typingLabel } from "../chat/typing";
import { chatTypingKey, resetTypingThrottle, sendChatTyping, useTyping } from "../store/typing";
import MessageMenu, { type MenuAction } from "./messages/MessageMenu";
import {
  ComposerContext,
  EditedMark,
  ReactionChips,
  ReplyQuote,
  revealMessage,
  useMessageMenuTrigger,
} from "./messages/parts";

const STICKER_SIZE = 160;

interface Props {
  showBack?: boolean;
}

/** Обычный текст (не картинка, не стикер, расшифровался) — его можно исправить и скопировать. */
function isPlainText(payload: string): boolean {
  return !parseImage(payload) && !parseSticker(payload) && !isUnreadable(payload);
}

/** Реакции чата в виде, который понимает общая строка чипов. */
function reactionsOf(msg: Message) {
  return msg.reactions?.map((r) => ({ user_id: r.user_id, emoji: r.payload }));
}

export default function MessageView({ showBack = false }: Props) {
  const {
    activeChatId,
    chats,
    messages,
    loadingMessages,
    sendMessage,
    sendImage,
    editMessage,
    deleteMessage,
    hideMessage,
    react,
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
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [menu, setMenu] = useState<{ msg: Message; x: number; y: number } | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickersByKey = useStickersStore((st) => st.byKey);
  const stickersLoaded = useStickersStore((st) => st.loaded);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingIds = useTyping(activeChatId ? chatTypingKey(activeChatId) : null);

  const chat = chats.find((c) => c.id === activeChatId);
  const msgs = activeChatId ? (messages[activeChatId] ?? []) : [];
  const isDirect = chat?.type === "direct";
  const inputDisabled = isDirect && e2eReady === false;
  const lastId = msgs.length ? msgs[msgs.length - 1].id : null;

  useEffect(() => {
    setStickersOpen(false);
    setBackgroundOpen(false);
    setMenu(null);
    setReplyTo(null);
    setEditing(null);
  }, [activeChatId]);

  // Вниз — только когда пришло новое сообщение (а не при удалении или реакции).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lastId]);

  useEffect(() => {
    setSendError(null);
  }, [activeChatId]);

  // Сообщение, на которое отвечаем или которое правим, удалили — убираем и полосу над вводом.
  useEffect(() => {
    if (replyTo && !msgs.some((x) => x.id === replyTo.id)) setReplyTo(null);
    if (editing && !msgs.some((x) => x.id === editing.id)) {
      setEditing(null);
      setText("");
    }
  }, [msgs, replyTo, editing]);

  const closeMenu = useCallback(() => setMenu(null), []);

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

  const nameOf = (userId: string | null | undefined) => {
    if (userId && userId === currentUser?.id) return "Вы";
    return chat?.members.find((mb) => mb.user.id === userId)?.user.username ?? "Участник";
  };

  const myRole = chat?.members.find((mb) => mb.user.id === currentUser?.id)?.role;
  const canDeleteForAll = (msg: Message) =>
    msg.sender_id === currentUser?.id ||
    (chat?.type === "group" && (myRole === "owner" || myRole === "admin"));

  const callBusy = callPhase !== "idle" && callPhase !== "ended";

  const handleAudioCall = () => {
    if (!activeChatId || !peer.id || !isDirect || callBusy) return;
    void startAudioCall(activeChatId, peer.id);
  };

  const handleVideoCall = () => {
    if (!activeChatId || !peer.id || !isDirect || callBusy) return;
    void startVideoCall(activeChatId, peer.id);
  };

  const reportError = (err: unknown, fallback: string) => {
    if (err instanceof E2EError || err instanceof AttachmentError) setSendError(err.message);
    else setSendError(fallback);
  };

  const startReply = (msg: Message) => {
    setEditing(null);
    setReplyTo(msg);
    inputRef.current?.focus();
  };

  const startEdit = (msg: Message) => {
    setReplyTo(null);
    setEditing(msg);
    setText(msg.payload);
    setStickersOpen(false);
    inputRef.current?.focus();
  };

  const cancelContext = () => {
    if (editing) setText("");
    setEditing(null);
    setReplyTo(null);
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const payload = text.trim();
    if (!payload || !activeChatId || inputDisabled) return;
    setSendError(null);

    if (editing) {
      const target = editing;
      setEditing(null);
      setText("");
      if (payload === target.payload) return;
      try {
        await editMessage(activeChatId, target.id, payload);
      } catch (err) {
        reportError(err, "Не удалось исправить сообщение");
        setEditing(target);
        setText(payload);
      }
      return;
    }

    const reply = replyTo;
    setText("");
    setReplyTo(null);
    resetTypingThrottle(chatTypingKey(activeChatId));
    try {
      await sendMessage(activeChatId, payload, undefined, reply?.id);
    } catch (err) {
      reportError(err, "Не удалось отправить сообщение");
      setText(payload);
      setReplyTo(reply);
    }
  };

  const handleSticker = async (packId: string, sticker: StickerInfo) => {
    if (!activeChatId || inputDisabled) return;
    setStickersOpen(false);
    setSendError(null);
    const reply = replyTo;
    setReplyTo(null);
    try {
      await sendMessage(activeChatId, encodeSticker(packId, sticker.id), undefined, reply?.id);
    } catch (err) {
      reportError(err, "Не удалось отправить стикер");
      setReplyTo(reply);
    }
  };

  const handleImages = async (files: File[]) => {
    if (!activeChatId || inputDisabled || !files.length) return;
    setSendError(null);
    setStickersOpen(false);
    // Ответом становится первая картинка из выбранных.
    let reply = replyTo?.id;
    setReplyTo(null);
    // По одной, в порядке выбора: так они и лягут в чат.
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        await sendImage(activeChatId, file, reply);
        reply = undefined;
      } catch (err) {
        reportError(err, "Не удалось отправить картинку");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void handleImages(files);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && (replyTo || editing)) {
      e.preventDefault();
      cancelContext();
      return;
    }
    // ↑ в пустом поле — исправить своё последнее сообщение, как в Telegram.
    if (e.key === "ArrowUp" && !text && !editing && !inputDisabled) {
      const last = [...msgs]
        .reverse()
        .find((x) => x.sender_id === currentUser?.id && isPlainText(x.payload));
      if (last) {
        e.preventDefault();
        startEdit(last);
      }
    }
  };

  const handleReact = async (msg: Message, emoji: string) => {
    if (!activeChatId) return;
    setSendError(null);
    try {
      await react(activeChatId, msg.id, toggledReaction(myReaction(reactionsOf(msg), currentUser?.id), emoji));
    } catch (err) {
      reportError(err, "Не удалось поставить реакцию");
    }
  };

  const handleDelete = async (msg: Message, forAll: boolean) => {
    if (!activeChatId) return;
    const question = forAll
      ? isDirect
        ? `Удалить сообщение у вас и у ${peer.username}?`
        : "Удалить сообщение у всех участников?"
      : "Удалить сообщение только у вас? У остальных оно останется.";
    if (!window.confirm(question)) return;
    setSendError(null);
    try {
      if (forAll) await deleteMessage(activeChatId, msg.id);
      else await hideMessage(activeChatId, msg.id);
    } catch {
      setSendError("Не удалось удалить сообщение");
    }
  };

  const menuActions = (msg: Message): MenuAction[] => {
    const own = msg.sender_id === currentUser?.id;
    const plain = isPlainText(msg.payload);
    const actions: MenuAction[] = [];
    if (!inputDisabled) actions.push({ label: "Ответить", onClick: () => startReply(msg) });
    if (own && plain && !inputDisabled) actions.push({ label: "Изменить", onClick: () => startEdit(msg) });
    if (plain) {
      actions.push({
        label: "Копировать текст",
        onClick: () => void navigator.clipboard?.writeText(msg.payload).catch(() => {}),
      });
    }
    if (canDeleteForAll(msg)) {
      actions.push({ label: "Удалить у всех", danger: true, onClick: () => void handleDelete(msg, true) });
    }
    actions.push({ label: "Удалить у меня", danger: true, onClick: () => void handleDelete(msg, false) });
    return actions;
  };

  const handleTextChange = (value: string) => {
    setText(value);
    if (activeChatId && !editing && value.trim()) sendChatTyping(activeChatId);
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

  const typingText = typingIds.length
    ? isDirect
      ? "печатает…"
      : typingLabel(typingIds.map((id) => nameOf(id)))
    : null;

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
            {typingText ? (
              <span className={m.typing}>{typingText}</span>
            ) : (
              <>
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
              </>
            )}
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
            title={inputDisabled ? "Фон чата — после настройки шифрования" : "Фон чата"}
            aria-label="Фон чата"
            disabled={inputDisabled}
            onClick={() => setBackgroundOpen(true)}
          >
            <IconImage size={18} />
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

      <div className={s.messages} ref={listRef}>
        {loadingMessages && <div className={s.hint}>Загрузка...</div>}
        {msgs.map((msg) => (
          <ChatMessage
            key={msg.id}
            msg={msg}
            isOwn={msg.sender_id === currentUser?.id}
            showAuthor={!isDirect}
            myId={currentUser?.id}
            nameOf={nameOf}
            stickersLoaded={stickersLoaded}
            stickerOf={(pack, id) => stickersByKey[`${pack}/${id}`]}
            statusIcon={statusIcon}
            statusClass={statusClass}
            onOpenMenu={(x, y) => setMenu({ msg, x, y })}
            onReact={inputDisabled ? undefined : (emoji) => void handleReact(msg, emoji)}
            onQuoteClick={(id) => revealMessage(listRef.current, id)}
          />
        ))}
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
      {replyTo && (
        <ComposerContext
          kind="reply"
          title={replyTo.sender_id === currentUser?.id ? "Ответ себе" : `Ответ ${nameOf(replyTo.sender_id)}`}
          text={messagePreview(replyTo.payload)}
          onCancel={cancelContext}
        />
      )}
      {editing && (
        <ComposerContext
          kind="edit"
          title="Редактирование"
          text={editing.payload}
          onCancel={cancelContext}
        />
      )}
      <form className={s.composer} onSubmit={(e) => void handleSend(e)}>
        <button
          type="button"
          className={s.attachBtn}
          title="Фото"
          aria-label="Отправить картинку"
          onClick={() => fileInputRef.current?.click()}
          disabled={inputDisabled || !!editing}
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
            ref={inputRef}
            className={s.textInput}
            placeholder={
              inputDisabled ? "Ожидание ключей шифрования..." : "Написать сообщение..."
            }
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={inputDisabled}
          />
          <button
            type="button"
            className={stickersOpen ? s.stickerBtnActive : s.stickerBtn}
            onClick={() => setStickersOpen((open) => !open)}
            disabled={inputDisabled || !!editing}
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
            aria-label={editing ? "Сохранить" : "Отправить"}
          >
            {editing ? "✓" : <IconSend size={18} />}
          </button>
        ) : (
          <button className={s.micBtn} type="button" title="Голосовые скоро" disabled>
            <IconMic size={18} />
          </button>
        )}
      </form>
      </div>

      {menu && (
        <MessageMenu
          at={menu}
          reaction={
            inputDisabled
              ? null
              : {
                  current: myReaction(reactionsOf(menu.msg), currentUser?.id),
                  onPick: (emoji) => void handleReact(menu.msg, emoji),
                }
          }
          actions={menuActions(menu.msg)}
          onClose={closeMenu}
        />
      )}

      {backgroundOpen && (
        <ChatBackgroundDialog
          chatId={activeChatId}
          isDirect={isDirect}
          peerName={peer.username}
          onClose={() => setBackgroundOpen(false)}
        />
      )}

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

interface ChatMessageProps {
  msg: Message;
  isOwn: boolean;
  /** В группе над чужим сообщением — имя автора. */
  showAuthor: boolean;
  myId: string | undefined;
  nameOf: (userId: string | null | undefined) => string;
  stickersLoaded: boolean;
  stickerOf: (pack: string, id: string) => StickerInfo | undefined;
  statusIcon: (status: string) => string;
  statusClass: (status: string) => string;
  onOpenMenu: (x: number, y: number) => void;
  onReact?: (emoji: string) => void;
  onQuoteClick: (messageId: string) => void;
}

function ChatMessage({
  msg,
  isOwn,
  showAuthor,
  myId,
  nameOf,
  stickersLoaded,
  stickerOf,
  statusIcon,
  statusClass,
  onOpenMenu,
  onReact,
  onQuoteClick,
}: ChatMessageProps) {
  const trigger = useMessageMenuTrigger(onOpenMenu);
  const unavailable = msg.payload.startsWith("Сообщение недоступно");
  const image = unavailable ? null : parseImage(msg.payload);
  const stickerRef = unavailable ? null : parseSticker(msg.payload);
  const sticker = stickerRef ? stickerOf(stickerRef.pack, stickerRef.id) : undefined;
  // Стикер без пузыря; неизвестный (пак убрали с сервера) — обычной строкой.
  const asSticker = !!stickerRef && (!!sticker || !stickersLoaded);
  const groups = groupReactions(reactionsOf(msg), myId);

  const bubbleClass = asSticker
    ? isOwn ? s.ownSticker : s.otherSticker
    : `${isOwn ? s.ownBubble : s.otherBubble}${image ? ` ${s.imageBubble}` : ""}`;

  return (
    <div data-mid={msg.id} className={`${bubbleClass} ${m.menuHost}`} {...trigger}>
      {showAuthor && !isOwn && <span className={s.author}>{nameOf(msg.sender_id)}</span>}
      {msg.reply_to && (
        <ReplyQuote
          tone={isOwn && !asSticker ? "own" : "other"}
          author={nameOf(msg.reply_to.sender_id)}
          text={messagePreview(msg.reply_to.payload)}
          onClick={() => onQuoteClick(msg.reply_to!.id)}
        />
      )}
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
      <ReactionChips groups={groups} nameOf={nameOf} onToggle={onReact} />
      <span className={s.meta}>
        <EditedMark at={msg.edited_at} />
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
      <button
        type="button"
        className={m.menuBtn}
        aria-label="Действия с сообщением"
        title="Действия"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onOpenMenu(r.left, r.bottom + 4);
        }}
      >
        ⌄
      </button>
    </div>
  );
}

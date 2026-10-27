import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isUnreadable, SAVED_CHAT_TITLE, useChatStore } from "../store/chat";
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
  IconSearch,
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
import { MIN_VOICE_SEC, parseVoice } from "../attachments/voice";
import { parseFile } from "../attachments/file";
import ChatFile from "./chat/ChatFile";
import { useMentionSuggest } from "./messages/MentionSuggest";
import { isAllWord } from "../chat/mentions";
import type { MentionKind } from "./LinkifiedText";
import w from "./constellation/Work.module.css";
import CustomStatusBadge from "./status/CustomStatusBadge";
import PinBar from "./messages/PinBar";
import ChatSearchPanel from "./messages/ChatSearchPanel";
import LinkPreviewCard from "./messages/LinkPreviewCard";
import { useComposerPreview } from "../chat/useComposerPreview";
import { encodeWithPreview } from "../chat/linkPreview";
import { canRecordVoice, RecorderError, VoiceRecorder } from "../voice/recorder";
import VoiceMessage from "./voice/VoiceMessage";
import VoiceRecorderBar from "./voice/VoiceRecorderBar";
import ChatActions from "./chat/ChatActions";
import ForwardDialog from "./chat/ForwardDialog";
import ScheduledBar from "./chat/ScheduledBar";
import SavedAvatar from "./chat/SavedAvatar";
import WhenDialog from "./chat/WhenDialog";
import c from "./chat/Chat.module.css";
import { formatWhen } from "../chat/when";
import { timeLeft, ttlLabel } from "../chat/ttl";
import { useBlocksStore, useIsBlocked } from "../store/blocks";
import { notifyInfo } from "../notifications/notify";
import { apiError } from "./constellation/rules";
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
import { displayName } from "../utils/profile";

const STICKER_SIZE = 160;
/** Сколько столбиков живой волны видно во время записи. */
const LIVE_BARS = 60;

interface Props {
  showBack?: boolean;
}

/** Обычный текст (не картинка, не стикер, расшифровался) — его можно исправить и скопировать. */
function isPlainText(payload: string): boolean {
  return (
    !parseImage(payload) && !parseSticker(payload) && !parseVoice(payload) && !parseFile(payload) && !isUnreadable(payload)
  );
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
    sendVoice,
    sendFile,
    editMessage,
    deleteMessage,
    hideMessage,
    react,
    scheduleMessage,
    setReminder,
    revealRequest,
    clearRevealRequest,
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
  /** Загрузка файла: название и доля 0…1. */
  const [fileUpload, setFileUpload] = useState<{ name: string; share: number } | null>(null);
  const [attachMenu, setAttachMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pins = useChatStore((st) => (activeChatId ? st.pins[activeChatId] : undefined));
  const pinMessage = useChatStore((st) => st.pinMessage);
  const openMessage = useChatStore((st) => st.openMessage);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [menu, setMenu] = useState<{ msg: Message; x: number; y: number } | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const [recording, setRecording] = useState<{ elapsed: number; levels: number[] } | null>(null);
  const [sendingVoice, setSendingVoice] = useState(false);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  /** Окно «когда»: отложить отправку текста из поля или напомнить о сообщении. */
  const [whenFor, setWhenFor] = useState<{ kind: "schedule"; text: string } | { kind: "remind"; msg: Message } | null>(null);
  const [sendMenu, setSendMenu] = useState<{ x: number; y: number } | null>(null);
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
  const isSaved = chat?.type === "saved";
  const inputDisabled = (isDirect || isSaved) && e2eReady === false;
  const lastId = msgs.length ? msgs[msgs.length - 1].id : null;

  useEffect(() => {
    setStickersOpen(false);
    setBackgroundOpen(false);
    setMenu(null);
    setReplyTo(null);
    setEditing(null);
    // Ушли из чата посреди записи — запись пропадает, микрофон гаснет.
    return () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(null);
    };
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
  const peerBlocked = useIsBlocked(presencePeerId);
  const closeSendMenu = useCallback(() => setSendMenu(null), []);
  // Правая кнопка или долгое нажатие на «Отправить» — «Отправить позже».
  const sendTrigger = useMessageMenuTrigger((x, y) => setSendMenu({ x, y }));

  // Открыли чат из напоминания — прокручиваем к сообщению, когда оно в ленте.
  useEffect(() => {
    if (!revealRequest || revealRequest.chatId !== activeChatId || loadingMessages) return;
    if (!revealMessage(listRef.current, revealRequest.messageId)) {
      notifyInfo({ title: "Напоминание", body: "Сообщение уже удалено или слишком давнее" });
    }
    clearRevealRequest();
  }, [revealRequest, activeChatId, loadingMessages, clearRevealRequest]);
  const peerStatusText = usePresenceText(presencePeerId);
  const groupOnline = usePresenceStore((st) =>
    chat?.type === "group"
      ? chat.members.filter((m) => m.user.id !== currentUser?.id && st.byId[m.user.id]?.online).length
      : 0
  );
  // @упоминания — только в группах: подсказка при вводе и подсветка в сообщениях.
  const isGroup = chat?.type === "group";
  const groupNames = useMemo(
    () => (isGroup ? (chat?.members ?? []).filter((m) => m.user.id !== currentUser?.id).map((m) => m.user.username) : []),
    [isGroup, chat?.members, currentUser?.id]
  );
  const mentionKind = useMemo<MentionKind | undefined>(() => {
    if (!isGroup) return undefined;
    const names = new Map((chat?.members ?? []).map((m) => [m.user.username.toLowerCase(), m.user.id]));
    return (name) => {
      if (isAllWord(name)) return "other";
      const id = names.get(name.toLowerCase());
      return id ? (id === currentUser?.id ? "me" : "other") : null;
    };
  }, [isGroup, chat?.members, currentUser?.id]);
  const mention = useMentionSuggest({ text, setText, inputRef, names: groupNames, allowAll: isGroup });
  const composerPreview = useComposerPreview(text, !editing);

  // Открыли чат — сразу печатаем, без клика по полю. Поле ждало ключей — фокус, когда дождалось.
  // На сенсорных экранах не трогаем: клавиатура закрыла бы переписку.
  useEffect(() => {
    if (!activeChatId || inputDisabled) return;
    if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
    inputRef.current?.focus();
  }, [activeChatId, inputDisabled]);

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
    if (chat.type === "group" || chat.type === "saved") {
      return { id: null, username: chat.type === "saved" ? SAVED_CHAT_TITLE : (chat.name ?? "Группа"), avatar_url: null };
    }
    const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
    return {
      id: other?.id ?? null,
      username: displayName(other) ?? "",
      avatar_url: other?.avatar_url ?? null,
    };
  })();

  const nameOf = (userId: string | null | undefined) => {
    if (userId && userId === currentUser?.id) return "Вы";
    return displayName(chat?.members.find((mb) => mb.user.id === userId)?.user) ?? "Участник";
  };

  const myRole = chat?.members.find((mb) => mb.user.id === currentUser?.id)?.role;
  const canDeleteForAll = (msg: Message) =>
    msg.sender_id === currentUser?.id ||
    (chat?.type === "group" && (myRole === "owner" || myRole === "admin"));
  // Закрепляют оба в личном чате, владелец и админы — в группе.
  const canPin = chat?.type !== "group" || myRole === "owner" || myRole === "admin";
  const pinnedIds = new Set((pins ?? []).map((p) => p.id));

  const callBusy = callPhase !== "idle" && callPhase !== "ended";
  const canCall = isDirect && !!peer.id && !callBusy && !peerBlocked;

  const handleAudioCall = () => {
    if (!activeChatId || !peer.id || !canCall) return;
    void startAudioCall(activeChatId, peer.id);
  };

  const handleVideoCall = () => {
    if (!activeChatId || !peer.id || !canCall) return;
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
    const preview = composerPreview.preview;
    setText("");
    setReplyTo(null);
    composerPreview.reset();
    resetTypingThrottle(chatTypingKey(activeChatId));
    try {
      await sendMessage(activeChatId, preview ? encodeWithPreview(payload, preview) : payload, undefined, reply?.id);
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

  const handleFiles = async (files: File[]) => {
    if (!activeChatId || inputDisabled || !files.length) return;
    setSendError(null);
    setStickersOpen(false);
    let reply = replyTo?.id;
    setReplyTo(null);
    for (const file of files) {
      setFileUpload({ name: file.name, share: 0 });
      try {
        await sendFile(activeChatId, file, reply, (share) => setFileUpload({ name: file.name, share }));
        reply = undefined;
      } catch (err) {
        reportError(err, `Не удалось отправить «${file.name}»`);
      } finally {
        setFileUpload(null);
      }
    }
  };

  /** Перетащили или вставили: картинки — как фото, остальное — файлами. */
  const handleDropped = (files: File[]) => {
    const images = files.filter((f) => /^image\/(jpeg|png|gif|webp)$/.test(f.type));
    const others = files.filter((f) => !images.includes(f));
    if (images.length) void handleImages(images);
    if (others.length) void handleFiles(others);
  };

  const startRecording = async () => {
    if (!activeChatId || inputDisabled || recorderRef.current) return;
    setSendError(null);
    setStickersOpen(false);
    const recorder = new VoiceRecorder();
    recorderRef.current = recorder;
    recorder.onTick = (level, elapsed) =>
      setRecording((r) => ({ elapsed, levels: [...(r?.levels ?? []), level].slice(-LIVE_BARS) }));
    recorder.onLimit = () => void finishRecording();
    try {
      await recorder.start();
      setRecording({ elapsed: 0, levels: [] });
    } catch (err) {
      recorderRef.current = null;
      recorder.cancel();
      setSendError(err instanceof RecorderError ? err.message : "Не удалось начать запись");
    }
  };

  const cancelRecording = () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecording(null);
  };

  const finishRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder || !activeChatId) return;
    recorderRef.current = null;
    setRecording(null);
    const chatId = activeChatId;
    const reply = replyTo;
    try {
      const rec = await recorder.stop();
      if (rec.dur < MIN_VOICE_SEC || !rec.bytes.length) {
        setSendError("Слишком короткое голосовое — не отправлено");
        return;
      }
      setReplyTo(null);
      setSendingVoice(true);
      await sendVoice(chatId, rec, reply?.id);
    } catch (err) {
      reportError(err, "Не удалось отправить голосовое");
      setReplyTo(reply);
    } finally {
      setSendingVoice(false);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    handleDropped(files);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mention.onKeyDown(e)) return;
    if (e.key === "Escape" && (replyTo || editing)) {
      e.preventDefault();
      cancelContext();
      return;
    }
    // ↑ в пустом поле — исправить своё последнее сообщение, как в Telegram.
    if (e.key === "ArrowUp" && !text && !editing && !inputDisabled) {
      const last = [...msgs]
        .reverse()
        .find((x) => x.sender_id === currentUser?.id && !x.forwarded_from && isPlainText(x.payload));
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
    if (own && plain && !msg.forwarded_from && !inputDisabled) actions.push({ label: "Изменить", onClick: () => startEdit(msg) });
    if (plain) {
      actions.push({
        label: "Копировать текст",
        onClick: () => void navigator.clipboard?.writeText(msg.payload).catch(() => {}),
      });
    }
    if (!isUnreadable(msg.payload)) actions.push({ label: "Переслать…", onClick: () => setForwarding(msg) });
    actions.push({ label: "Напомнить…", onClick: () => setWhenFor({ kind: "remind", msg }) });
    if (canPin && activeChatId) {
      const pinned = pinnedIds.has(msg.id);
      actions.push({
        label: pinned ? "📌 Открепить" : "📌 Закрепить",
        onClick: () => void pinMessage(activeChatId, msg.id, !pinned).catch((err) => reportError(err, "Не удалось закрепить")),
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
    mention.syncCaret();
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
    if (isSaved) return "Видите только вы · E2E";
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
    <div
      className={s.root}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files") || inputDisabled || peerBlocked) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Ушли за пределы чата (а не на вложенный элемент).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        if (!inputDisabled && !peerBlocked && !editing) handleDropped(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className={c.dropZone}>
          Отпустите, чтобы отправить
        </div>
      )}
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
        {isSaved ? (
          <SavedAvatar size="sm" />
        ) : (
          <UserAvatar username={peer.username || "?"} avatarUrl={peer.avatar_url} size="sm" userId={peer.id} />
        )}
        <div className={s.headerInfo}>
          <span className={s.name}>
            {peer.username} {isDirect && <CustomStatusBadge userId={presencePeerId} />}
          </span>
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
                {chat?.ttl_seconds ? ` · ⏱ ${ttlLabel(chat.ttl_seconds)}` : ""}
              </>
            )}
          </span>
        </div>
        <div className={s.headerActions}>
          <button
            type="button"
            className={s.iconBtn}
            title="Поиск в чате"
            aria-label="Поиск в чате"
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen((o) => !o)}
          >
            <IconSearch size={18} />
          </button>
          {!isSaved && (
            <>
              <button
                type="button"
                className={s.iconBtn}
                title={isDirect ? "Аудиозвонок" : "Звонки только в личных чатах"}
                disabled={!canCall}
                onClick={handleAudioCall}
              >
                <IconPhone size={18} />
              </button>
              <button
                type="button"
                className={s.iconBtn}
                title={isDirect ? "Видеозвонок" : "Звонки только в личных чатах"}
                disabled={!canCall}
                onClick={handleVideoCall}
              >
                <IconVideo size={18} />
              </button>
            </>
          )}
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
          {chat && (
            <ChatActions chat={chat} className={s.iconBtn} title="Ещё">
              <IconMore size={18} />
            </ChatActions>
          )}
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
      {searchOpen && activeChatId && (
        <ChatSearchPanel chatId={activeChatId} nameOf={nameOf} onClose={() => setSearchOpen(false)} />
      )}
      {!!pins?.length && activeChatId && (
        <PinBar
          items={pins.map((p) => ({ id: p.id, author: nameOf(p.sender_id), text: messagePreview(p.payload) }))}
          onOpen={(id) => void openMessage(activeChatId, id)}
          onUnpin={canPin ? (id) => void pinMessage(activeChatId, id, false).catch(() => {}) : undefined}
        />
      )}

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
            mention={mentionKind}
          />
        ))}
        {uploading > 0 && (
          <div className={s.hint}>
            {uploading > 1 ? `Отправка картинок: ${uploading}…` : "Отправка картинки…"}
          </div>
        )}
        {sendingVoice && <div className={s.hint}>Отправка голосового…</div>}
        {fileUpload && (
          <div className={s.hint}>
            📎 «{fileUpload.name}»: {fileUpload.share < 1 ? `загружаем ${Math.round(fileUpload.share * 100)}%` : "отправляем…"}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {peerBlocked ? (
        <div className={c.blockedBar}>
          Вы заблокировали {peer.username}
          <button
            type="button"
            className={s.bannerAction}
            onClick={() => void useBlocksStore.getState().unblock(peer.id!).catch(() => {})}
          >
            Разблокировать
          </button>
        </div>
      ) : (
      <div className={s.composerWrap}>
      <ScheduledBar chatId={activeChatId} />
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
      {composerPreview.preview && !editing && (
        <div className={s.composerPreview}>
          <LinkPreviewCard preview={composerPreview.preview} onRemove={composerPreview.dismiss} />
        </div>
      )}
      {recording ? (
        <div className={s.composer}>
          <VoiceRecorderBar
            elapsed={recording.elapsed}
            levels={recording.levels}
            onCancel={cancelRecording}
            onSend={() => void finishRecording()}
          />
        </div>
      ) : (
      <form className={s.composer} onSubmit={(e) => void handleSend(e)} style={{ position: "relative" }}>
        {mention.popup}
        <button
          type="button"
          className={s.attachBtn}
          title="Фото или файл"
          aria-label="Прикрепить"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAttachMenu({ x: r.left, y: r.top - 100 });
          }}
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
        <input
          ref={docInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void handleFiles(files);
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
            onSelect={mention.syncCaret}
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
            title={editing ? undefined : "Правая кнопка — отправить позже"}
            {...(editing ? {} : sendTrigger)}
          >
            {editing ? "✓" : <IconSend size={18} />}
          </button>
        ) : (
          <button
            className={s.micBtn}
            type="button"
            title={canRecordVoice() ? "Записать голосовое" : "Этот браузер не умеет записывать звук"}
            aria-label="Записать голосовое"
            disabled={inputDisabled || !!editing || !canRecordVoice()}
            onClick={() => void startRecording()}
          >
            <IconMic size={18} />
          </button>
        )}
      </form>
      )}
      </div>
      )}

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

      {attachMenu && (
        <MessageMenu
          at={attachMenu}
          reaction={null}
          actions={[
            { label: "🖼 Фото", onClick: () => fileInputRef.current?.click() },
            { label: "📎 Файл (до 50 МБ)", onClick: () => docInputRef.current?.click() },
          ]}
          onClose={() => setAttachMenu(null)}
        />
      )}

      {sendMenu && (
        <MessageMenu
          at={sendMenu}
          reaction={null}
          actions={[
            {
              label: "Отправить позже…",
              onClick: () => {
                const value = text.trim();
                if (value) setWhenFor({ kind: "schedule", text: value });
              },
            },
          ]}
          onClose={closeSendMenu}
        />
      )}

      {whenFor && activeChatId && (
        <WhenDialog
          title={whenFor.kind === "schedule" ? "Отправить позже" : "Напомнить о сообщении"}
          hint={
            whenFor.kind === "schedule"
              ? "Сообщение зашифруется сейчас и уйдёт само в выбранное время — даже если вы будете не в сети."
              : "Придёт уведомление, а по нажатию откроется это сообщение."
          }
          onPick={async (at) => {
            try {
              if (whenFor.kind === "schedule") {
                await scheduleMessage(activeChatId, whenFor.text, at, replyTo?.id);
                setText("");
                setReplyTo(null);
                notifyInfo({ title: "Отложено", body: `Отправится ${formatWhen(at)}` });
              } else {
                await setReminder(activeChatId, whenFor.msg.id, at);
                notifyInfo({ title: "Напомним", body: formatWhen(at) });
              }
            } catch (err) {
              if (err instanceof E2EError) throw err;
              throw new Error(apiError(err, "Не получилось — попробуйте ещё раз"));
            }
          }}
          onClose={() => setWhenFor(null)}
        />
      )}

      {forwarding && <ForwardDialog message={forwarding} onClose={() => setForwarding(null)} />}

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
  /** Подсветка @имён (в группах). */
  mention?: MentionKind;
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
  mention,
}: ChatMessageProps) {
  const trigger = useMessageMenuTrigger(onOpenMenu);
  const unavailable = msg.payload.startsWith("Сообщение недоступно");
  const image = unavailable ? null : parseImage(msg.payload);
  const voice = unavailable ? null : parseVoice(msg.payload);
  const file = unavailable || image || voice ? null : parseFile(msg.payload);
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
      {msg.forwarded_from && (
        <span className={c.forwarded}>
          Переслано от <b>{msg.forwarded_from}</b>
        </span>
      )}
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
      ) : voice ? (
        <VoiceMessage chatId={msg.chat_id} voice={voice} tone={isOwn ? "own" : "other"} />
      ) : file ? (
        <ChatFile chatId={msg.chat_id} file={file} tone={isOwn ? "own" : "other"} />
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
          {unavailable ? (
            msg.payload
          ) : (
            <LinkifiedText
              text={msg.payload}
              linkClassName={s.link}
              mention={mention}
              mentionClassName={w.mention}
              mentionMeClassName={w.mentionMe}
            />
          )}
        </span>
      )}
      {msg.link_preview && !unavailable && <LinkPreviewCard preview={msg.link_preview} tone={isOwn ? "own" : "other"} />}
      <ReactionChips groups={groups} nameOf={nameOf} onToggle={onReact} />
      <span className={s.meta}>
        {msg.expires_at && (
          <span className={c.expiry} title={`Исчезнет через ${timeLeft(msg.expires_at)}`} aria-label="Исчезающее">
            ⏱
          </span>
        )}
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

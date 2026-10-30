import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { starsApi, type StarAsset, type StarBookmark, type StarChannel, type StarDetail, type StarMessage } from "../../api/stars";
import { stickerFileUrl } from "../../api/stickers";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import { useStickersStore } from "../../store/stickers";
import { parseSticker } from "../../stickers/format";
import Sticker from "../Sticker";
import StarText, { onlyEmoji } from "./StarText";
import PollCard from "./PollCard";
import LfgCard from "./LfgCard";
import PollDialog from "./PollDialog";
import LfgDialog from "./LfgDialog";
import RulesCard from "./RulesCard";
import StarPicker from "./StarPicker";
import { memberColor } from "./MyTags";
import { formatWhen } from "../../chat/when";
import g from "./Gaming.module.css";
import w from "./Work.module.css";
import AcksDialog from "./AcksDialog";
import StarFileView from "./StarFileView";
import NotifyDialog from "../NotifyDialog";
import { channelLevel, levelSummary, settingKey, starLevel, useNotifyStore } from "../../notifications/levels";
import { useMentionSuggest } from "../messages/MentionSuggest";
import { useStarMentions } from "./starMentions";
import { MAX_FILE_BYTES } from "../../attachments/file";
import c from "../chat/Chat.module.css";
import type { MentionKind } from "../LinkifiedText";
import { isStaff, mentionsMe } from "../../store/stars";
import PinBar from "../messages/PinBar";
import LinkPreviewCard from "../messages/LinkPreviewCard";
import StarSearchPanel from "./StarSearchPanel";
import BotAvatar from "./BotAvatar";
import { useComposerPreview } from "../../chat/useComposerPreview";
import ComposerInput, { type ComposerHandle } from "../messages/ComposerInput";
import FormatBar, { useFormatBarOpen } from "../messages/FormatBar";
import { IconSearch } from "../icons";
import UserAvatar from "../UserAvatar";
import { IconBack, IconFormat, IconGear, IconSatellite, IconSend } from "../icons";
import { apiError, can, formatTime, outranks } from "./rules";
import s from "./Constellation.module.css";
import m from "../messages/Messages.module.css";
import { groupReactions, myReaction, toggledReaction } from "../../chat/reactions";
import { typingLabel } from "../../chat/typing";
import {
  resetTypingThrottle,
  satelliteTypingKey,
  sendSatelliteTyping,
  useTyping,
} from "../../store/typing";
import MessageMenu, { type MenuAction } from "../messages/MessageMenu";
import {
  ComposerContext,
  EditedMark,
  ReactionChips,
  ReplyQuote,
  revealMessage,
  useMessageMenuTrigger,
} from "../messages/parts";
import { displayName } from "../../utils/profile";
import type { LinkPreview } from "../../chat/linkPreview";
import { notifyInfo } from "../../notifications/notify";
import ScheduleButton from "../chat/ScheduleButton";
import WhenDialog from "../chat/WhenDialog";
import StarScheduledBar from "./StarScheduledBar";
import StarFilesView from "./StarFilesView";
import NotesView from "./NotesView";
import EditHistory from "../messages/EditHistory";
import { BotButtons } from "./Bots";
import { BookmarkDialog, BookmarksBar, ChannelTabs, PinnedList, canAddBookmark, type ChannelTab } from "./ChannelTabs";
import { stripMarkup } from "../../chat/markdown";

const EMPTY: StarMessage[] = [];
const NO_ASSETS: StarAsset[] = [];

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
  const scheduleMessage = useStarsStore((st) => st.scheduleMessage);
  const editMessage = useStarsStore((st) => st.editMessage);
  const deleteMessage = useStarsStore((st) => st.deleteMessage);
  const react = useStarsStore((st) => st.react);
  const loadOlder = useStarsStore((st) => st.loadOlder);
  const assets = useStarsStore((st) => st.assets[detail.id] ?? NO_ASSETS);
  const loadAssets = useStarsStore((st) => st.loadAssets);
  const openThread = useStarsStore((st) => st.openThread);
  const sendFile = useStarsStore((st) => st.sendFile);
  const pins = useStarsStore((st) => st.pins[channel.id]);
  const loadPins = useStarsStore((st) => st.loadPins);
  const pinMessage = useStarsStore((st) => st.pinMessage);
  const jumpTo = useStarsStore((st) => st.jumpTo);
  const revealRequest = useStarsStore((st) => st.revealRequest);
  const clearReveal = useStarsStore((st) => st.clearReveal);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tab, setTab] = useState<ChannelTab>("messages");
  const bookmarks = useStarsStore((st) => st.bookmarks[channel.id]);
  const loadBookmarks = useStarsStore((st) => st.loadBookmarks);
  const [bookmarkDialog, setBookmarkDialog] = useState<{ bookmark?: StarBookmark } | null>(null);
  const notifySettings = useNotifyStore((st) => st.settings);
  const ack = useStarsStore((st) => st.ack);
  const typingIds = useTyping(satelliteTypingKey(channel.id));
  const [dialog, setDialog] = useState<"poll" | "lfg" | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  const emoji = useMemo(
    () => Object.fromEntries(assets.filter((a) => a.kind === "emoji").map((a) => [a.name, a.url])),
    [assets]
  );
  const me = detail.members.find((mb) => mb.user.id === myId);
  const timedOutUntil =
    me?.timeout_until && Date.parse(me.timeout_until) > Date.now() ? me.timeout_until : null;
  const slowMode = channel.slow_mode_sec ?? 0;
  // Общий Спутник другой Звезды: модерация и настройки — у хозяина, здесь мы обычные участники.
  const guestHere = !!channel.shared_from;
  const shared = guestHere || !!channel.shared_with?.length;
  const isAdmin = (detail.my_role === "owner" || detail.my_role === "admin") && !guestHere;
  const announcement = !!channel.announcement;
  const [askAck, setAskAck] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [fileUpload, setFileUpload] = useState<{ name: string; share: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [acksOf, setAcksOf] = useState<StarMessage | null>(null);

  useEffect(() => {
    void loadAssets(detail.id).catch(() => {});
  }, [detail.id, loadAssets]);

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ msg: StarMessage; x: number; y: number } | null>(null);
  const [replyTo, setReplyTo] = useState<StarMessage | null>(null);
  const [editing, setEditing] = useState<StarMessage | null>(null);
  const [scheduledDraft, setScheduledDraft] = useState<{
    starId: string; channelId: string; text: string; draft: string;
    reply_to_id?: string; ack_required: boolean; link_preview?: LinkPreview;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerHandle = useRef<ComposerHandle>(null);
  const [formatOpen, toggleFormat] = useFormatBarOpen();
  const stickToBottom = useRef(true);
  const lastId = messages.length ? messages[messages.length - 1].id : null;

  const roleOf = (userId: string) => detail.members.find((mb) => mb.user.id === userId)?.role;
  const starMentions = useStarMentions(detail, myId);
  const mentionKind = starMentions.kind;
  const mention = useMentionSuggest({
    text,
    setText,
    inputRef,
    names: starMentions.names,
    allowAll: isStaff(detail.my_role),
    options: starMentions.options,
  });
  const level = channelLevel(notifySettings, detail.id, channel.id);
  const composerPreview = useComposerPreview(text, !editing);
  // Закрепляют те, кто может удалять чужие сообщения (модераторы и выше).
  const canPin = can(detail, "delete_messages") && !guestHere;
  const pinnedIds = new Set((pins ?? []).map((p) => p.id));
  const nameOf = (userId: string) =>
    displayName(detail.members.find((mb) => mb.user.id === userId)?.user) ?? "Бывший участник";

  const canDelete = (msg: StarMessage) => {
    if (msg.sender?.id === myId) return true;
    if (!can(detail, "delete_messages") || guestHere) return false;
    const senderRole = msg.sender ? roleOf(msg.sender.id) : undefined;
    return !senderRole || outranks(detail.my_role, senderRole);
  };

  useEffect(() => {
    stickToBottom.current = true;
    setError(null);
    setMenu(null);
    setReplyTo(null);
    setEditing(null);
    setText("");
    setPickerOpen(false);
    setAskAck(false);
    setScheduledDraft(null);
    setTab("messages");
    setBookmarkDialog(null);
  }, [channel.id]);

  useEffect(() => {
    if (!pins) void loadPins(detail.id, channel.id).catch(() => {});
  }, [detail.id, channel.id, pins, loadPins]);

  useEffect(() => {
    if (!bookmarks) void loadBookmarks(detail.id, channel.id).catch(() => {});
  }, [detail.id, channel.id, bookmarks, loadBookmarks]);

  // Из поиска или закрепа: прокрутить к сообщению, когда оно в ленте.
  useEffect(() => {
    if (!revealRequest || revealRequest.channelId !== channel.id) return;
    stickToBottom.current = false;
    requestAnimationFrame(() => revealMessage(listRef.current, revealRequest.messageId));
    clearReveal();
  }, [revealRequest, channel.id, messages, clearReveal]);

  // Сообщение, на которое отвечаем или которое правим, удалили — убираем и полосу над вводом.
  useEffect(() => {
    if (replyTo && !messages.some((x) => x.id === replyTo.id)) setReplyTo(null);
    if (editing && !messages.some((x) => x.id === editing.id)) {
      setEditing(null);
      setText("");
    }
  }, [messages, replyTo, editing]);

  // Новые сообщения прокручиваем вниз, только если человек и так был внизу.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastId, channel.id]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const startReply = (msg: StarMessage) => {
    setEditing(null);
    setReplyTo(msg);
    inputRef.current?.focus();
  };

  const startEdit = (msg: StarMessage) => {
    setReplyTo(null);
    setEditing(msg);
    setText(msg.text);
    inputRef.current?.focus();
  };

  const cancelContext = () => {
    if (editing) setText("");
    setEditing(null);
    setReplyTo(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setError(null);

    if (editing) {
      const target = editing;
      setEditing(null);
      setText("");
      if (value === target.text) return;
      try {
        await editMessage(target, value);
      } catch (err) {
        setEditing(target);
        setText(value);
        setError(apiError(err, "Не удалось исправить сообщение"));
      }
      return;
    }

    const reply = replyTo;
    const withAck = announcement && askAck;
    const preview = composerPreview.preview;
    setText("");
    setReplyTo(null);
    setAskAck(false);
    composerPreview.reset();
    stickToBottom.current = true;
    resetTypingThrottle(satelliteTypingKey(channel.id));
    try {
      await sendMessage(value, reply?.id, withAck, preview);
    } catch (err) {
      setText(value);
      setReplyTo(reply);
      setAskAck(withAck);
      setError(apiError(err, "Не удалось отправить сообщение"));
    }
  };

  const openSchedule = () => {
    const value = text.trim();
    if (!value || editing) return;
    setScheduledDraft({
      starId: detail.id, channelId: channel.id, text: value, draft: text,
      reply_to_id: replyTo?.id, ack_required: announcement && askAck,
      link_preview: composerPreview.preview ?? undefined,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.onKeyDown(e)) return;
    if (e.key === "Escape" && (replyTo || editing)) {
      e.preventDefault();
      cancelContext();
      return;
    }
    // ↑ в пустом поле — исправить своё последнее сообщение.
    if (e.key === "ArrowUp" && !text && !editing) {
      const last = [...messages].reverse().find((x) => x.sender?.id === myId && editable(x));
      if (last) {
        e.preventDefault();
        startEdit(last);
      }
    }
  };

  const onReact = (msg: StarMessage, emoji: string) => {
    setError(null);
    void react(msg, toggledReaction(myReaction(msg.reactions, myId), emoji)).catch((err) =>
      setError(apiError(err, "Не удалось поставить реакцию"))
    );
  };

  const menuActions = (msg: StarMessage): MenuAction[] => {
    const actions: MenuAction[] = [];
    if (!announcement || isAdmin) actions.push({ label: "Ответить", onClick: () => startReply(msg) });
    if (msg.kind !== "system") {
      actions.push({ label: "💬 Ответить в ветке", onClick: () => showThread(msg) });
    }
    if (canPin && msg.kind !== "system") {
      const pinned = pinnedIds.has(msg.id);
      actions.push({
        label: pinned ? "📌 Открепить" : "📌 Закрепить",
        onClick: () => void pinMessage(msg, !pinned).catch((err) => setError(apiError(err, "Не удалось закрепить"))),
      });
    }
    if (msg.sender?.id === myId && editable(msg)) actions.push({ label: "Изменить", onClick: () => startEdit(msg) });
    actions.push({
      label: "Копировать текст",
      onClick: () => void navigator.clipboard?.writeText(msg.text).catch(() => {}),
    });
    if (canDelete(msg)) {
      actions.push({
        label: "Удалить у всех",
        danger: true,
        onClick: () => {
          if (window.confirm("Удалить это сообщение для всех?")) {
            void deleteMessage(msg).catch((err) => setError(apiError(err)));
          }
        },
      });
    }
    return actions;
  };

  const typingText = typingLabel(typingIds.map(nameOf));

  const handleFiles = async (files: File[]) => {
    if (composer || editing) return;
    setError(null);
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`«${file.name}» больше 50 МБ — такой не отправить`);
        continue;
      }
      setFileUpload({ name: file.name, share: 0 });
      stickToBottom.current = true;
      try {
        await sendFile(file, { onProgress: (share) => setFileUpload({ name: file.name, share }) });
      } catch (err) {
        setError(apiError(err, `Не удалось отправить «${file.name}»`));
      } finally {
        setFileUpload(null);
      }
    }
  };

  const showThread = (msg: StarMessage) => {
    setError(null);
    void openThread(msg).catch((err) => setError(apiError(err, "Не удалось открыть ветку")));
  };

  const onAck = (msg: StarMessage) => {
    setError(null);
    void ack(msg).catch((err) => setError(apiError(err, "Не удалось отметить")));
  };

  /** Стикер или эмодзи — отправить сразу (в ответ, если выбран ответ). */
  const sendQuick = async (value: string) => {
    setPickerOpen(false);
    const reply = replyTo;
    setReplyTo(null);
    stickToBottom.current = true;
    try {
      await sendMessage(value, reply?.id);
    } catch (err) {
      setReplyTo(reply);
      setError(apiError(err, "Не удалось отправить"));
    }
  };

  const composer = (() => {
    if (detail.rules_accepted === false) return <RulesCard detail={detail} />;
    if (timedOutUntil) {
      return <div className={g.notice}>⏳ Вы в тайм-ауте до {formatWhen(timedOutUntil)} — писать пока нельзя</div>;
    }
    if (announcement && !isAdmin) {
      return (
        <div className={g.notice}>
          📢 Канал объявлений: пишут владелец и админы. Обсудить — «💬 Ответить в ветке» у объявления.
        </div>
      );
    }
    return null;
  })();

  return (
    <div
      className={w.satelliteRoot}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files") || composer) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void handleFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && <div className={c.dropZone}>Отпустите, чтобы отправить в «{channel.name}»</div>}
      <div className={s.channelHeader}>
        {onBack && (
          <button type="button" className={s.iconBtn} onClick={onBack} aria-label="Назад">
            <IconBack />
          </button>
        )}
        <IconSatellite />
        <div className={s.channelTitle}>
          <span className={s.channelTitleName}>{channel.name}</span>
          <span className={s.channelTitleSub}>
            {announcement ? "📢 Объявления" : "Спутник"} ·{" "}
            {channel.shared_from
              ? `🔗 общий, Звезды «${channel.shared_from.name}»`
              : channel.shared_with?.length
                ? `🔗 общий с ${channel.shared_with.map((x) => `«${x.name}»`).join(", ")}`
                : detail.name}{" "}
            · без сквозного шифрования
          </span>
        </div>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setSearchOpen((o) => !o)}
          aria-label="Поиск сообщений"
          aria-pressed={searchOpen}
          title="Поиск сообщений"
        >
          <IconSearch size={17} />
        </button>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setNotifyOpen(true)}
          aria-label="Уведомления Спутника"
          title={`Уведомления: ${levelSummary(level, notifySettings[settingKey("channel", channel.id)])}`}
        >
          {level === "none" ? "🔕" : "🔔"}
        </button>
        {can(detail, "manage_channels") && !guestHere && (
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
        {can(detail, "manage_channels") && guestHere && (
          <button
            type="button"
            className={`${s.secondary} ${s.small}`}
            title="Убрать общий Спутник из этой Звезды — у хозяина он останется"
            onClick={() => {
              if (!window.confirm(`Отключить общий Спутник «${channel.name}» от «${detail.name}»?`)) return;
              void starsApi.removeShare(detail.id, channel.id, detail.id).catch((err) => setError(apiError(err, "Не удалось отключить")));
            }}
          >
            Отключить
          </button>
        )}
      </div>

      {searchOpen && <StarSearchPanel detail={detail} channelId={channel.id} onClose={() => setSearchOpen(false)} />}
      <ChannelTabs
        tab={tab}
        onTab={setTab}
        pinCount={pins?.length ?? 0}
        onAddBookmark={canAddBookmark(detail, channel) ? () => setBookmarkDialog({}) : undefined}
      />
      <BookmarksBar
        detail={detail}
        bookmarks={bookmarks ?? []}
        myId={myId}
        onEdit={(bookmark) => setBookmarkDialog({ bookmark })}
      />
      {bookmarkDialog && (
        <BookmarkDialog
          detail={detail}
          channel={channel}
          bookmark={bookmarkDialog.bookmark}
          onClose={() => setBookmarkDialog(null)}
        />
      )}

      {tab === "notes" ? (
        <NotesView detail={detail} channel={channel} emoji={emoji} mention={mentionKind} />
      ) : tab === "pins" ? (
        <PinnedList
          pins={pins}
          emoji={emoji}
          onOpen={(p) => {
            setTab("messages");
            void jumpTo({ id: p.id, star_id: detail.id, channel_id: channel.id, thread_id: null });
          }}
          onUnpin={canPin ? (p) => void pinMessage(p, false).catch(() => {}) : undefined}
        />
      ) : tab === "files" ? (
        <StarFilesView
          detail={detail}
          channel={channel}
          onOpenChannel={() => setTab("messages")}
          onOpenMessage={(f) => {
            setTab("messages");
            void jumpTo({ id: f.message_id!, star_id: detail.id, channel_id: channel.id, thread_id: null });
          }}
        />
      ) : (
      <>
      {!!pins?.length && (
        <PinBar
          items={pins.map((p) => ({
            id: p.id,
            author: p.bot_name ?? displayName(p.sender) ?? "Бывший участник",
            text: previewText(p.text) || (p.file ? `📎 ${p.file.name}` : ""),
          }))}
          onOpen={(id) => void jumpTo({ id, star_id: detail.id, channel_id: channel.id, thread_id: null })}
          onUnpin={
            canPin
              ? (id) => {
                  const msg = pins.find((p) => p.id === id);
                  if (msg) void pinMessage(msg, false).catch(() => {});
                }
              : undefined
          }
        />
      )}

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
        {messages.map((msg) => (
          <SatelliteMessage
            key={msg.id}
            msg={msg}
            detail={detail}
            emoji={emoji}
            assets={assets}
            myId={myId}
            nameOf={nameOf}
            onOpenMenu={(x, y) => setMenu({ msg, x, y })}
            onReact={(emoji) => onReact(msg, emoji)}
            onQuoteClick={(id) => {
              stickToBottom.current = false;
              revealMessage(listRef.current, id);
            }}
            mention={mentionKind}
            onOpenThread={() => showThread(msg)}
            onAck={() => onAck(msg)}
            onShowAcks={msg.sender?.id === myId || isAdmin ? () => setAcksOf(msg) : undefined}
          />
        ))}
      </div>

      <StarScheduledBar starId={detail.id} channelId={channel.id} />
      {error && (
        <div className={s.error} style={{ padding: "6px 16px" }}>
          {error}
        </div>
      )}
      {typingText && <div className={`${s.typingLine} ${m.typing}`}>{typingText}</div>}
      {fileUpload && (
        <div className={s.typingLine}>
          📎 «{fileUpload.name}»: {fileUpload.share < 1 ? `загружаем ${Math.round(fileUpload.share * 100)}%` : "отправляем…"}
        </div>
      )}
      {replyTo && (
        <ComposerContext
          kind="reply"
          title={`Ответ ${replyTo.sender?.id === myId ? "себе" : (displayName(replyTo.sender) ?? "участнику")}`}
          text={previewText(replyTo.text)}
          onCancel={cancelContext}
        />
      )}
      {editing && (
        <ComposerContext kind="edit" title="Редактирование" text={editing.text} onCancel={cancelContext} />
      )}
      {composer ?? (
      <div className={g.composerWrap}>
      {slowMode > 0 && <div className={g.slowHint}>🐢 Медленный режим: одно сообщение в {slowMode} с</div>}
      {announcement && !editing && (
        <label className={w.askAck}>
          <input type="checkbox" checked={askAck} onChange={(e) => setAskAck(e.target.checked)} />
          Попросить подтвердить «Ознакомлен(а)»
        </label>
      )}
      {mention.popup}
      {composerPreview.preview && !editing && (
        <div style={{ padding: "0 16px 6px" }}>
          <LinkPreviewCard preview={composerPreview.preview} onRemove={composerPreview.dismiss} />
        </div>
      )}
      {pickerOpen && (
        <StarPicker
          assets={assets}
          onSticker={(value) => void sendQuick(value)}
          onEmoji={(code) => {
            setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}${code} `);
            inputRef.current?.focus();
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {formatOpen && <FormatBar onFormat={(kind) => composerHandle.current?.format(kind)} />}
      <form className={s.composer} onSubmit={(e) => void submit(e)}>
        <button
          type="button"
          className={g.composerExtra}
          aria-label="Файл, опрос или сбор группы"
          title="Файл, опрос или сбор группы"
          disabled={!!editing}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPlusMenu({ x: r.left, y: r.top - 140 });
          }}
        >
          +
        </button>
        <ComposerInput
          ref={inputRef}
          handleRef={composerHandle}
          className={s.composerInput}
          value={text}
          onValueChange={(value) => {
            setText(value);
            mention.syncCaret();
            if (!editing && value.trim()) sendSatelliteTyping(detail.id, channel.id);
          }}
          onSelect={mention.syncCaret}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (!files.length || editing) return;
            e.preventDefault();
            void handleFiles(files);
          }}
          onKeyDown={onKeyDown}
          placeholder={`Написать в «${channel.name}»`}
          maxLength={4000}
          aria-label="Сообщение"
        />
        <button
          type="button"
          className={formatOpen ? `${g.composerExtra} ${g.composerExtraOn}` : g.composerExtra}
          aria-label="Форматирование"
          aria-pressed={formatOpen}
          title="Форматирование"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleFormat}
        >
          <IconFormat size={18} />
        </button>
        <button
          type="button"
          className={g.composerExtra}
          aria-label="Стикеры и эмодзи"
          title="Стикеры и эмодзи"
          data-sticker-toggle
          disabled={!!editing}
          onClick={() => setPickerOpen((o) => !o)}
        >
          🙂
        </button>
        {!editing && !!text.trim() && <ScheduleButton onClick={openSchedule} />}
        <button
          type="submit"
          className={s.primary}
          disabled={!text.trim()}
          aria-label={editing ? "Сохранить" : "Отправить"}
          style={{ padding: "0 16px" }}
        >
          {editing ? "✓" : <IconSend size={18} />}
        </button>
      </form>
      </div>
      )}
      </>
      )}

      {scheduledDraft && (
        <WhenDialog
          title="Отправить позже"
          hint="Сообщение отправится в выбранное время, даже если вы будете не в сети."
          onPick={async (at) => {
            const draft = scheduledDraft;
            try {
              await scheduleMessage(draft.starId, draft.channelId, draft.text, at, {
                reply_to_id: draft.reply_to_id,
                ack_required: draft.ack_required,
                link_preview: draft.link_preview,
              });
              const current = useStarsStore.getState();
              if (current.activeStarId === draft.starId && current.activeChannelByStar[draft.starId] === draft.channelId) {
                setText((value) => value === draft.draft ? "" : value);
                setReplyTo((value) => value?.id === draft.reply_to_id ? null : value);
                setAskAck(false);
                composerPreview.reset();
                resetTypingThrottle(satelliteTypingKey(draft.channelId));
              }
              notifyInfo({ title: "Отложено", body: `Отправится ${formatWhen(at)}` });
            } catch (err) {
              throw new Error(apiError(err, "Не удалось отложить сообщение"));
            }
          }}
          onClose={() => setScheduledDraft(null)}
        />
      )}
      {plusMenu && (
        <MessageMenu
          at={plusMenu}
          reaction={null}
          actions={[
            { label: "📎 Файл (до 50 МБ)", onClick: () => fileInputRef.current?.click() },
            // Опросы и сборы живут внутри одной Звезды — в общем Спутнике их нет.
            ...(shared
              ? []
              : [
                  { label: "📊 Опрос", onClick: () => setDialog("poll") },
                  { label: "🎮 Сбор группы", onClick: () => setDialog("lfg") },
                ]),
          ]}
          onClose={() => setPlusMenu(null)}
        />
      )}
      {dialog === "poll" && <PollDialog starId={detail.id} channelId={channel.id} onClose={() => setDialog(null)} />}
      {dialog === "lfg" && <LfgDialog starId={detail.id} channelId={channel.id} onClose={() => setDialog(null)} />}
      {acksOf && <AcksDialog message={acksOf} onClose={() => setAcksOf(null)} />}
      {notifyOpen && (
        <NotifyDialog
          scope="channel"
          targetId={channel.id}
          title={`Уведомления: #${channel.name}`}
          inherited={starLevel(notifySettings, detail.id)}
          inheritLabel={`Как во всей Звезде (${levelSummary(starLevel(notifySettings, detail.id), notifySettings[settingKey("star", detail.id)]).toLowerCase()})`}
          onClose={() => setNotifyOpen(false)}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void handleFiles(files);
        }}
      />

      {menu && (
        <MessageMenu
          at={menu}
          reaction={{
            current: myReaction(menu.msg.reactions, myId),
            onPick: (emoji) => onReact(menu.msg, emoji),
          }}
          actions={menuActions(menu.msg)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

/** Строка для цитаты: стикер — «Стикер», файл без подписи — «📎 Файл», остальное как есть. */
export function previewText(text: string): string {
  // У файла без подписи текста нет.
  if (!text) return "📎 Файл";
  return parseSticker(text) ? "Стикер" : stripMarkup(text);
}

/** Исправлять можно только обычный текст (не опрос, сбор, приветствие или стикер). */
export function editable(msg: StarMessage): boolean {
  return (msg.kind ?? "text") === "text" && !parseSticker(msg.text);
}

export function SatelliteMessage({
  msg,
  detail,
  emoji,
  assets,
  myId,
  nameOf,
  onOpenMenu,
  onReact,
  onQuoteClick,
  onOpenThread,
  onAck,
  onShowAcks,
  mention,
}: {
  msg: StarMessage;
  detail: StarDetail;
  emoji: Record<string, string>;
  assets: StarAsset[];
  myId: string | undefined;
  nameOf: (userId: string) => string;
  onOpenMenu: (x: number, y: number) => void;
  onReact: (emoji: string) => void;
  onQuoteClick: (messageId: string) => void;
  /** Нет — сообщение уже в ветке (сводку и кнопку не показываем). */
  onOpenThread?: () => void;
  onAck?: () => void;
  /** Кто ознакомился — автору и админам. */
  onShowAcks?: () => void;
  /** Подсветка @имён. */
  mention?: MentionKind;
}) {
  const trigger = useMessageMenuTrigger(onOpenMenu);
  const stickersByKey = useStickersStore((st) => st.byKey);
  const [showEdits, setShowEdits] = useState(false);
  if (msg.kind === "system") {
    return (
      <div data-mid={msg.id} className={g.system}>
        <StarText text={msg.text} emoji={emoji} />
      </div>
    );
  }
  const sticker = parseSticker(msg.text);
  const starSticker = sticker?.pack === "star" ? assets.find((a) => a.id === sticker.id) : undefined;
  const packSticker = sticker && sticker.pack !== "star" ? stickersByKey[`${sticker.pack}/${sticker.id}`] : undefined;
  const color = memberColor(detail, msg.sender?.id);
  // В общем Спутнике — автор из другой Звезды (в нашем списке участников его нет).
  const msgChannel = detail.channels.find((c) => c.id === msg.channel_id);
  const external =
    msg.kind !== "bot" &&
    !!msg.sender &&
    !!(msgChannel?.shared_from || msgChannel?.shared_with?.length) &&
    !detail.members.some((mb) => mb.user.id === msg.sender!.id);
  const body =
    msg.kind === "file" && msg.file ? (
      <>
        <StarFileView starId={msg.star_id} file={msg.file} />
        {msg.text && (
          <div className={s.messageText}>
            <StarText text={msg.text} emoji={emoji} linkClassName={s.messageLink} mention={mention} />
          </div>
        )}
      </>
    ) : msg.kind === "poll" && msg.poll ? (
      <PollCard message={msg} detail={detail} />
    ) : msg.kind === "lfg" && msg.lfg ? (
      <LfgCard message={msg} detail={detail} />
    ) : starSticker ? (
      <img className={g.stickerMessage} src={starSticker.url} alt={starSticker.name} />
    ) : packSticker ? (
      <Sticker url={stickerFileUrl(packSticker)} emoji={packSticker.emoji} size={140} mode="loop" />
    ) : sticker ? (
      <span className={s.messageTime}>Стикер недоступен</span>
    ) : (
      <div className={`${s.messageText} ${onlyEmoji(msg.text, emoji) ? g.bigEmoji : ""}`}>
        <StarText text={msg.text} emoji={emoji} linkClassName={s.messageLink} mention={mention} />
      </div>
    );
  return (
    <div
      data-mid={msg.id}
      className={`${s.message} ${m.menuHost} ${mentionsMe(msg, myId) ? w.mentionedMessage : ""}`}
      {...trigger}
    >
      {msg.kind === "bot" ? (
        <BotAvatar kind={msg.bot_kind} />
      ) : (
        <UserAvatar
          username={displayName(msg.sender) ?? "?"}
          avatarUrl={msg.sender?.avatar_url ?? null}
          size="sm"
        />
      )}
      <div className={s.messageBody}>
        <div className={s.messageHead}>
          <span className={s.messageAuthor} style={color ? { color } : undefined}>
            {msg.kind === "bot" ? (msg.bot_name ?? "Интеграция") : (displayName(msg.sender) ?? "Бывший участник")}
          </span>
          {msg.kind === "bot" && <span className={w.botBadge}>бот</span>}
          {external && (
            <span className={w.botBadge} title="Участник другой Звезды общего Спутника">
              внешний
            </span>
          )}
          <span className={s.messageTime}>
            {formatTime(msg.created_at)} <EditedMark at={msg.edited_at} onOpen={() => setShowEdits(true)} />
          </span>
        </div>
        {msg.reply_to && (
          <div className={s.messageExtra}>
            <ReplyQuote
              author={displayName(msg.reply_to.sender) ?? "Бывший участник"}
              text={previewText(msg.reply_to.text)}
              onClick={() => onQuoteClick(msg.reply_to!.id)}
            />
          </div>
        )}
        {body}
        {!!msg.buttons?.length && <BotButtons starId={detail.id} message={msg} />}
        {msg.link_preview && <LinkPreviewCard preview={msg.link_preview} />}
        {!!msg.reactions?.length && (
          <div className={s.messageExtra}>
            <ReactionChips groups={groupReactions(msg.reactions, myId)} nameOf={nameOf} onToggle={onReact} />
          </div>
        )}
        {msg.ack_required && (
          <div className={w.ackRow}>
            {msg.sender?.id !== myId && (
              <button
                type="button"
                className={msg.acked ? `${w.ackBtn} ${w.ackDone}` : w.ackBtn}
                disabled={msg.acked || !onAck}
                onClick={onAck}
              >
                {msg.acked ? "✓ Вы ознакомились" : "Ознакомлен(а)"}
              </button>
            )}
            {onShowAcks ? (
              <button type="button" className={w.ackCount} onClick={onShowAcks} title="Кто ознакомился">
                👁 {msg.ack_count ?? 0}
              </button>
            ) : (
              <span className={w.ackCount}>👁 {msg.ack_count ?? 0}</span>
            )}
          </div>
        )}
        {onOpenThread && (msg.thread_count ?? 0) > 0 && (
          <button type="button" className={w.threadSummary} onClick={onOpenThread}>
            <span className={w.threadFaces}>
              {(msg.thread_participants ?? []).map((id) => (
                <span key={id} className={w.threadFace} title={nameOf(id)}>
                  {nameOf(id).slice(0, 1).toUpperCase()}
                </span>
              ))}
            </span>
            <span className={w.threadCount}>💬 {repliesLabel(msg.thread_count ?? 0)}</span>
            {msg.thread_last_at && <span className={w.threadLast}>последний {formatWhen(msg.thread_last_at)}</span>}
          </button>
        )}
      </div>
      <button
        type="button"
        className={s.messageMenuBtn}
        aria-label="Действия с сообщением"
        title="Действия"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onOpenMenu(r.left, r.bottom + 4);
        }}
      >
        ⋯
      </button>
      {showEdits && (
        <EditHistory
          current={{ text: msg.text, at: msg.edited_at ?? msg.created_at }}
          load={async () =>
            (await starsApi.messageRevisions(msg.star_id, msg.channel_id, msg.id)).map((r) => ({
              text: r.text,
              at: r.written_at,
            }))
          }
          onClose={() => setShowEdits(false)}
        />
      )}
    </div>
  );
}

export function repliesLabel(n: number): string {
  const tail = n % 100;
  const last = n % 10;
  const word =
    tail >= 11 && tail <= 14 ? "ответов" : last === 1 ? "ответ" : last >= 2 && last <= 4 ? "ответа" : "ответов";
  return `${n} ${word}`;
}

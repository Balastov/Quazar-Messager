import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StarAsset, StarChannel, StarDetail, StarMessage } from "../../api/stars";
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
import UserAvatar from "../UserAvatar";
import { IconBack, IconGear, IconSatellite, IconSend } from "../icons";
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
  const editMessage = useStarsStore((st) => st.editMessage);
  const deleteMessage = useStarsStore((st) => st.deleteMessage);
  const react = useStarsStore((st) => st.react);
  const loadOlder = useStarsStore((st) => st.loadOlder);
  const assets = useStarsStore((st) => st.assets[detail.id] ?? NO_ASSETS);
  const loadAssets = useStarsStore((st) => st.loadAssets);
  const openThread = useStarsStore((st) => st.openThread);
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
  const isAdmin = detail.my_role === "owner" || detail.my_role === "admin";
  const announcement = !!channel.announcement;
  const [askAck, setAskAck] = useState(false);
  const [acksOf, setAcksOf] = useState<StarMessage | null>(null);

  useEffect(() => {
    void loadAssets(detail.id).catch(() => {});
  }, [detail.id, loadAssets]);

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ msg: StarMessage; x: number; y: number } | null>(null);
  const [replyTo, setReplyTo] = useState<StarMessage | null>(null);
  const [editing, setEditing] = useState<StarMessage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const lastId = messages.length ? messages[messages.length - 1].id : null;

  const roleOf = (userId: string) => detail.members.find((mb) => mb.user.id === userId)?.role;
  const nameOf = (userId: string) =>
    detail.members.find((mb) => mb.user.id === userId)?.user.username ?? "Бывший участник";

  const canDelete = (msg: StarMessage) => {
    if (msg.sender?.id === myId) return true;
    if (!can(detail, "delete_messages")) return false;
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
  }, [channel.id]);

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
    setText("");
    setReplyTo(null);
    setAskAck(false);
    stickToBottom.current = true;
    resetTypingThrottle(satelliteTypingKey(channel.id));
    try {
      await sendMessage(value, reply?.id, withAck);
    } catch (err) {
      setText(value);
      setReplyTo(reply);
      setAskAck(withAck);
      setError(apiError(err, "Не удалось отправить сообщение"));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
          <span className={s.channelTitleSub}>
            {announcement ? "📢 Объявления" : "Спутник"} · {detail.name} · без сквозного шифрования
          </span>
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
            onOpenThread={() => showThread(msg)}
            onAck={() => onAck(msg)}
            onShowAcks={msg.sender?.id === myId || isAdmin ? () => setAcksOf(msg) : undefined}
          />
        ))}
      </div>

      {error && (
        <div className={s.error} style={{ padding: "6px 16px" }}>
          {error}
        </div>
      )}
      {typingText && <div className={`${s.typingLine} ${m.typing}`}>{typingText}</div>}
      {replyTo && (
        <ComposerContext
          kind="reply"
          title={`Ответ ${replyTo.sender?.id === myId ? "себе" : (replyTo.sender?.username ?? "участнику")}`}
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
      <form className={s.composer} onSubmit={(e) => void submit(e)}>
        <button
          type="button"
          className={g.composerExtra}
          aria-label="Опрос или сбор группы"
          title="Опрос или сбор группы"
          disabled={!!editing}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPlusMenu({ x: r.left, y: r.top - 100 });
          }}
        >
          +
        </button>
        <input
          ref={inputRef}
          className={s.composerInput}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!editing && e.target.value.trim()) sendSatelliteTyping(detail.id, channel.id);
          }}
          onKeyDown={onKeyDown}
          placeholder={`Написать в «${channel.name}»`}
          maxLength={4000}
          aria-label="Сообщение"
        />
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

      {plusMenu && (
        <MessageMenu
          at={plusMenu}
          reaction={null}
          actions={[
            { label: "📊 Опрос", onClick: () => setDialog("poll") },
            { label: "🎮 Сбор группы", onClick: () => setDialog("lfg") },
          ]}
          onClose={() => setPlusMenu(null)}
        />
      )}
      {dialog === "poll" && <PollDialog starId={detail.id} channelId={channel.id} onClose={() => setDialog(null)} />}
      {dialog === "lfg" && <LfgDialog starId={detail.id} channelId={channel.id} onClose={() => setDialog(null)} />}
      {acksOf && <AcksDialog message={acksOf} onClose={() => setAcksOf(null)} />}

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
    </>
  );
}

/** Строка для цитаты: стикер — «Стикер», остальное как есть. */
export function previewText(text: string): string {
  return parseSticker(text) ? "Стикер" : text;
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
}) {
  const trigger = useMessageMenuTrigger(onOpenMenu);
  const stickersByKey = useStickersStore((st) => st.byKey);
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
  const body =
    msg.kind === "poll" && msg.poll ? (
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
        <StarText text={msg.text} emoji={emoji} linkClassName={s.messageLink} />
      </div>
    );
  return (
    <div data-mid={msg.id} className={`${s.message} ${m.menuHost}`} {...trigger}>
      <UserAvatar
        username={msg.sender?.username ?? "?"}
        avatarUrl={msg.sender?.avatar_url ?? null}
        size="sm"
      />
      <div className={s.messageBody}>
        <div className={s.messageHead}>
          <span className={s.messageAuthor} style={color ? { color } : undefined}>
            {msg.sender?.username ?? "Бывший участник"}
          </span>
          <span className={s.messageTime}>
            {formatTime(msg.created_at)} <EditedMark at={msg.edited_at} />
          </span>
        </div>
        {msg.reply_to && (
          <div className={s.messageExtra}>
            <ReplyQuote
              author={msg.reply_to.sender?.username ?? "Бывший участник"}
              text={previewText(msg.reply_to.text)}
              onClick={() => onQuoteClick(msg.reply_to!.id)}
            />
          </div>
        )}
        {body}
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

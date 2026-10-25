import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StarChannel, StarDetail, StarMessage } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import UserAvatar from "../UserAvatar";
import { IconBack, IconGear, IconSatellite, IconSend } from "../icons";
import { apiError, can, formatTime, outranks } from "./rules";
import s from "./Constellation.module.css";
import m from "../messages/Messages.module.css";
import LinkifiedText from "../LinkifiedText";
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
  const typingIds = useTyping(satelliteTypingKey(channel.id));

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
    setText("");
    setReplyTo(null);
    stickToBottom.current = true;
    resetTypingThrottle(satelliteTypingKey(channel.id));
    try {
      await sendMessage(value, reply?.id);
    } catch (err) {
      setText(value);
      setReplyTo(reply);
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
      const last = [...messages].reverse().find((x) => x.sender?.id === myId);
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
    const actions: MenuAction[] = [{ label: "Ответить", onClick: () => startReply(msg) }];
    if (msg.sender?.id === myId) actions.push({ label: "Изменить", onClick: () => startEdit(msg) });
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
        {messages.map((msg) => (
          <SatelliteMessage
            key={msg.id}
            msg={msg}
            myId={myId}
            nameOf={nameOf}
            onOpenMenu={(x, y) => setMenu({ msg, x, y })}
            onReact={(emoji) => onReact(msg, emoji)}
            onQuoteClick={(id) => {
              stickToBottom.current = false;
              revealMessage(listRef.current, id);
            }}
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
          text={replyTo.text}
          onCancel={cancelContext}
        />
      )}
      {editing && (
        <ComposerContext kind="edit" title="Редактирование" text={editing.text} onCancel={cancelContext} />
      )}
      <form className={s.composer} onSubmit={(e) => void submit(e)}>
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
          type="submit"
          className={s.primary}
          disabled={!text.trim()}
          aria-label={editing ? "Сохранить" : "Отправить"}
          style={{ padding: "0 16px" }}
        >
          {editing ? "✓" : <IconSend size={18} />}
        </button>
      </form>

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

function SatelliteMessage({
  msg,
  myId,
  nameOf,
  onOpenMenu,
  onReact,
  onQuoteClick,
}: {
  msg: StarMessage;
  myId: string | undefined;
  nameOf: (userId: string) => string;
  onOpenMenu: (x: number, y: number) => void;
  onReact: (emoji: string) => void;
  onQuoteClick: (messageId: string) => void;
}) {
  const trigger = useMessageMenuTrigger(onOpenMenu);
  return (
    <div data-mid={msg.id} className={`${s.message} ${m.menuHost}`} {...trigger}>
      <UserAvatar
        username={msg.sender?.username ?? "?"}
        avatarUrl={msg.sender?.avatar_url ?? null}
        size="sm"
      />
      <div className={s.messageBody}>
        <div className={s.messageHead}>
          <span className={s.messageAuthor}>{msg.sender?.username ?? "Бывший участник"}</span>
          <span className={s.messageTime}>
            {formatTime(msg.created_at)} <EditedMark at={msg.edited_at} />
          </span>
        </div>
        {msg.reply_to && (
          <div className={s.messageExtra}>
            <ReplyQuote
              author={msg.reply_to.sender?.username ?? "Бывший участник"}
              text={msg.reply_to.text}
              onClick={() => onQuoteClick(msg.reply_to!.id)}
            />
          </div>
        )}
        <div className={s.messageText}>
          <LinkifiedText text={msg.text} linkClassName={s.messageLink} />
        </div>
        {!!msg.reactions?.length && (
          <div className={s.messageExtra}>
            <ReactionChips groups={groupReactions(msg.reactions, myId)} nameOf={nameOf} onToggle={onReact} />
          </div>
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

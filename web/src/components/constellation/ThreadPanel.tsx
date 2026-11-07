import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StarAsset, StarDetail, StarMessage } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import { myReaction, toggledReaction } from "../../chat/reactions";
import MessageMenu, { type MenuAction } from "../messages/MessageMenu";
import { ComposerContext, revealMessage } from "../messages/parts";
import { IconBack, IconFormat, IconSend } from "../icons";
import ComposerInput, { type ComposerHandle } from "../messages/ComposerInput";
import { useCompactComposer } from "../../chat/useCompactComposer";
import { useComposerDraft } from "../../chat/useComposerDraft";
import DraftNotice from "../messages/DraftNotice";
import FormatBar, { useFormatBarOpen } from "../messages/FormatBar";
import { SatelliteMessage, editable, repliesLabel } from "./SatelliteView";
import { useMentionSuggest } from "../messages/MentionSuggest";
import { useStarMentions } from "./starMentions";
import { isStaff } from "../../store/stars";
import { apiError, can, outranks } from "./rules";
import { formatWhen } from "../../chat/when";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";
import w from "./Work.module.css";
import { displayName } from "../../utils/profile";

const NO_ASSETS: StarAsset[] = [];

interface Props {
  detail: StarDetail;
  /** На телефоне — на весь экран, со стрелкой «назад». */
  fullscreen?: boolean;
}

/** Ветка обсуждения под сообщением Спутника: корень сверху, ответы ниже, своё поле ввода. */
export default function ThreadPanel({ detail, fullscreen = false }: Props) {
  const compactComposer = useCompactComposer();
  const [toolsAt, setToolsAt] = useState<{ x: number; y: number } | null>(null);
  const myId = useAuthStore((st) => st.user?.id);
  const thread = useStarsStore((st) => st.thread);
  const closeThread = useStarsStore((st) => st.closeThread);
  const sendThreadReply = useStarsStore((st) => st.sendThreadReply);
  const sendFile = useStarsStore((st) => st.sendFile);
  const editMessage = useStarsStore((st) => st.editMessage);
  const deleteMessage = useStarsStore((st) => st.deleteMessage);
  const react = useStarsStore((st) => st.react);
  const assets = useStarsStore((st) => st.assets[detail.id] ?? NO_ASSETS);
  const [editing, setEditing] = useState<StarMessage | null>(null);
  const draft = useComposerDraft(myId, thread ? ["thread", detail.id, thread.channelId, thread.rootId] : null, editing?.id ?? null);
  const { text, setText } = draft;
  const scopeRef = useRef(draft.key); scopeRef.current = draft.key;
  useLayoutEffect(() => { setEditing(null); setError(null); }, [draft.key]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ msg: StarMessage; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerHandle = useRef<ComposerHandle>(null);
  const [formatOpen, toggleFormat] = useFormatBarOpen();
  const closeMenu = useCallback(() => setMenu(null), []);
  const emoji = useMemo(
    () => Object.fromEntries(assets.filter((a) => a.kind === "emoji").map((a) => [a.name, a.url])),
    [assets]
  );
  const messages = thread?.messages ?? [];
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
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
  const lastId = messages.length ? messages[messages.length - 1].id : null;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  if (!thread) return null;
  const channel = detail.channels.find((c) => c.id === thread.channelId);
  const [root, ...replies] = messages;
  const me = detail.members.find((mb) => mb.user.id === myId);
  const timedOut = me?.timeout_until && Date.parse(me.timeout_until) > Date.now() ? me.timeout_until : null;

  const nameOf = (userId: string) =>
    displayName(detail.members.find((mb) => mb.user.id === userId)?.user) ?? "Бывший участник";
  const roleOf = (userId: string) => detail.members.find((mb) => mb.user.id === userId)?.role;
  const canDelete = (msg: StarMessage) => {
    if (msg.sender?.id === myId) return true;
    // В общем Спутнике другой Звезды чужие сообщения удаляют модераторы хозяина.
    if (!can(detail, "delete_messages") || channel?.shared_from) return false;
    const senderRole = msg.sender ? roleOf(msg.sender.id) : undefined;
    return !senderRole || outranks(detail.my_role, senderRole);
  };

  const onReact = (msg: StarMessage, value: string) => {
    setError(null);
    void react(msg, toggledReaction(myReaction(msg.reactions, myId), value)).catch((err) =>
      setError(apiError(err, "Не удалось поставить реакцию"))
    );
  };

  const actions = (msg: StarMessage): MenuAction[] => {
    const list: MenuAction[] = [];
    if (msg.sender?.id === myId && editable(msg) && msg.id !== root?.id) {
      list.push({
        label: "Изменить",
        onClick: () => {
          setEditing(msg);
          draft.setEditText(msg.text);
          inputRef.current?.focus();
        },
      });
    }
    list.push({ label: "Копировать текст", onClick: () => void navigator.clipboard?.writeText(msg.text).catch(() => {}) });
    if (canDelete(msg)) {
      list.push({
        label: msg.id === root?.id ? "Удалить вместе с веткой" : "Удалить у всех",
        danger: true,
        onClick: () => {
          const question = msg.id === root?.id ? "Удалить сообщение и все ответы в ветке?" : "Удалить этот ответ для всех?";
          if (window.confirm(question)) void deleteMessage(msg).catch((err) => setError(apiError(err)));
        },
      });
    }
    return list;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setError(null);
    if (editing) {
      const target = editing;
      if (value === target.text) { setEditing(null); draft.setEditText(""); return; }
      try {
        const saved = await draft.saveEdit(() => editMessage(target, value));
        if (saved) { setEditing(null); draft.setEditText(""); }
      } catch (err) {
        if (scopeRef.current !== draft.key || useAuthStore.getState().user?.id !== myId) return;
        setError(apiError(err, "Не удалось исправить"));
      }
      return;
    }
    try {
      await draft.send(() => sendThreadReply(value));
    } catch (err) {
      if (scopeRef.current !== draft.key || useAuthStore.getState().user?.id !== myId) return;
      setError(apiError(err, "Не удалось ответить"));
    }
  };

  const item = (msg: StarMessage) => (
    <SatelliteMessage
      key={msg.id}
      msg={msg}
      detail={detail}
      emoji={emoji}
      assets={assets}
      myId={myId}
      nameOf={nameOf}
      onOpenMenu={(x, y) => setMenu({ msg, x, y })}
      onReact={(value) => onReact(msg, value)}
      onQuoteClick={(id) => revealMessage(listRef.current, id)}
      mention={mentionKind}
    />
  );

  const attach = async (files: File[]) => {
    for (const file of files) {
      setUploading(file.name);
      setError(null);
      try {
        await sendFile(file, { inThread: true });
      } catch (err) {
        setError(apiError(err, `Не удалось отправить «${file.name}»`));
      } finally {
        setUploading(null);
      }
    }
  };

  const blocked =
    detail.rules_accepted === false
      ? "Сначала примите правила Звезды"
      : timedOut
        ? `⏳ Вы в тайм-ауте до ${formatWhen(timedOut)}`
        : null;

  return (
    <div className={fullscreen ? s.membersFull : w.threadPanel} aria-label="Ветка">
      <div className={s.channelHeader}>
        {fullscreen && (
          <button type="button" className={s.iconBtn} onClick={closeThread} aria-label="Назад">
            <IconBack />
          </button>
        )}
        <div className={s.channelTitle}>
          <span className={s.channelTitleName}>Ветка</span>
          <span className={s.channelTitleSub}>{channel ? `в «${channel.name}»` : ""}</span>
        </div>
        {!fullscreen && (
          <button type="button" className={s.iconBtn} onClick={closeThread} aria-label="Закрыть ветку" title="Закрыть ветку">
            ✕
          </button>
        )}
      </div>
      <div className={s.messages} ref={listRef}>
        {root && <div className={w.threadRoot}>{item(root)}</div>}
        {thread.loading && <div className={s.empty}>Загрузка…</div>}
        {!thread.loading && (
          <div className={w.threadDivider}>{replies.length ? repliesLabel(replies.length) : "Ответов пока нет — начните обсуждение"}</div>
        )}
        {replies.map(item)}
      </div>
      {error && (
        <div className={s.error} style={{ padding: "6px 16px" }}>
          {error}
        </div>
      )}
      {uploading && <div className={s.typingLine}>📎 Отправляем «{uploading}»…</div>}
      {editing && (
        <ComposerContext
          kind="edit"
          title="Редактирование"
          text={editing.text}
          onCancel={() => {
            setEditing(null);
            setText("");
          }}
        />
      )}
      {blocked ? (
        <div className={g.notice}>{blocked}</div>
      ) : (
        <>
        <DraftNotice error={draft.error && !editing} text={text} />
        {formatOpen && <FormatBar disabled={!draft.ready} onFormat={(kind) => composerHandle.current?.format(kind)} />}
        <form className={s.composer} onSubmit={(e) => void submit(e)} style={{ position: "relative" }}>
          {mention.popup}
          <button
            type="button"
            className={g.composerExtra}
            aria-label={compactComposer ? "Действия с сообщением" : "Отправить файл в ветку"}
            aria-haspopup={compactComposer ? "menu" : undefined}
            aria-expanded={compactComposer ? !!toolsAt : undefined}
            title={compactComposer ? "Действия с сообщением" : "Файл"}
            disabled={!draft.ready || (!compactComposer && (!!editing || !!uploading))}
            onClick={event => {
              if (!compactComposer) { fileRef.current?.click(); return; }
              const rect = event.currentTarget.getBoundingClientRect();
              setToolsAt({ x: rect.left, y: rect.top - 100 });
            }}
          >
            {compactComposer ? "+" : "📎"}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void attach(files);
            }}
          />
          <ComposerInput
            ref={inputRef}
            handleRef={composerHandle}
            className={s.composerInput}
            disabled={!draft.ready}
            value={text}
            onValueChange={(value) => {
              setText(value);
              mention.syncCaret();
            }}
            onSelect={mention.syncCaret}
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return;
              if (e.key === "Escape" && editing) {
                setEditing(null);
                setText("");
              }
            }}
            placeholder="Ответить в ветке"
            maxLength={4000}
            aria-label="Ответ в ветке"
          />
          {!compactComposer && <button
            type="button"
            className={formatOpen ? `${g.composerExtra} ${g.composerExtraOn}` : g.composerExtra}
            aria-label="Форматирование"
            aria-pressed={formatOpen}
            title="Форматирование"
            disabled={!draft.ready}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleFormat}
          >
            <IconFormat size={18} />
          </button>}
          <button type="submit" className={`${s.primary} ${s.composerSend}`} disabled={!text.trim() || !draft.ready || draft.sending} aria-label="Отправить">
            {editing ? "✓" : <IconSend size={18} />}
          </button>
        </form>
        </>
      )}
      {toolsAt && <MessageMenu at={toolsAt} reaction={null} actions={[
        ...(!editing && !uploading ? [{ label: "📎 Файл (до 50 МБ)", onClick: () => fileRef.current?.click() }] : []),
        { label: formatOpen ? "Скрыть форматирование" : "Форматирование", onClick: toggleFormat },
      ]} onClose={() => setToolsAt(null)} />}
      {menu && (
        <MessageMenu
          at={menu}
          reaction={{ current: myReaction(menu.msg.reactions, myId), onPick: (value) => onReact(menu.msg, value) }}
          actions={actions(menu.msg)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

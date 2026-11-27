import { useMemo, useState } from "react";
import { chatTitle, SAVED_CHAT_TITLE, useChatStore } from "../../store/chat";
import { useAuthStore } from "../../store/auth";
import UserAvatar from "../UserAvatar";
import SavedAvatar from "./SavedAvatar";
import c from "../constellation/Constellation.module.css";
import s from "./Chat.module.css";

/** Выбор чата: «Записная книжка» первой, дальше чаты по свежести. null — «Записной книжки» ещё нет. */
/** autoFocus — сразу в поиск (пересылка); для «Поделиться» на телефоне клавиатура закрыла бы список. */
export default function ChatPicker({ busy, onPick, autoFocus = true }: {
  busy: boolean;
  onPick: (chatId: string | null) => void;
  autoFocus?: boolean;
}) {
  const chats = useChatStore((st) => st.chats);
  const myId = useAuthStore((st) => st.user?.id);
  const [query, setQuery] = useState("");

  const saved = chats.find((ch) => ch.type === "saved");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chats
      .filter((ch) => ch.type !== "saved" && ch.type !== "news")
      .filter((ch) => !q || chatTitle(ch, myId).toLowerCase().includes(q));
  }, [chats, query, myId]);

  const showSaved = !query.trim() || SAVED_CHAT_TITLE.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <>
      <input
        className={c.input}
        placeholder="Поиск чата"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus={autoFocus}
      />
      <div className={s.chatList}>
        {showSaved && (
          <button type="button" className={s.chatRow} disabled={busy} onClick={() => onPick(saved?.id ?? null)}>
            <SavedAvatar size="sm" />
            {SAVED_CHAT_TITLE}
          </button>
        )}
        {list.map((ch) => {
          const other = ch.type === "direct" ? ch.members.find((m) => m.user.id !== myId)?.user : undefined;
          return (
            <button key={ch.id} type="button" className={s.chatRow} disabled={busy} onClick={() => onPick(ch.id)}>
              <UserAvatar
                username={chatTitle(ch, myId)}
                avatarUrl={other?.avatar_url ?? null}
                userId={other?.id ?? null}
                size="sm"
              />
              {chatTitle(ch, myId)}
            </button>
          );
        })}
        {!showSaved && list.length === 0 && <p className={c.hint}>Ничего не нашлось</p>}
      </div>
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { usersApi } from "../../api/users";
import type { User } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import { useChatStore } from "../../store/chat";
import { useContactsStore } from "../../store/contacts";
import { canSearchUsers, phoneSearchDigits } from "../../utils/phone";
import { displayName } from "../../utils/profile";
import { contactRows } from "../../chat/lists";
import UserAvatar from "../UserAvatar";
import ChatDialog from "./ChatDialog";
import c from "../constellation/Constellation.module.css";
import s from "./Chat.module.css";

/**
 * «Новый чат»: люди, с которыми вы уже общались или которые есть в телефонной книге, — от А до Я;
 * а если набрать ник, имя или номер — ещё и найденные в Quazar.
 */
export default function NewChatDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (userId: string) => void }) {
  const chats = useChatStore((st) => st.chats);
  const myId = useAuthStore((st) => st.user?.id);
  const phonebook = useContactsStore((st) => st.contacts);
  const phonebookNames = useContactsStore((st) => st.names);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);

  const people = useMemo(() => {
    const rows = contactRows(chats, phonebook, myId, phonebookNames).filter((row) => !row.bot);
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    const digits = phoneSearchDigits(query);
    return rows.filter((row) => row.name.toLowerCase().includes(q) || row.user.username.toLowerCase().includes(q)
      || (digits.length >= 3 && !!row.user.phone?.includes(digits)));
  }, [chats, phonebook, myId, phonebookNames, query]);

  useEffect(() => {
    if (!canSearchUsers(query)) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      usersApi
        .search(query.trim())
        .then((users) => !cancelled && setFound(users))
        .catch(() => !cancelled && setFound([]))
        .finally(() => !cancelled && setSearching(false));
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Найденные в Quazar, кроме тех, кто уже есть в списке выше.
  const known = new Set(people.map((row) => row.user.id));
  const more = found.filter((u) => u.id !== myId && !known.has(u.id));

  return (
    <ChatDialog title="Новый чат" onClose={onClose}>
      <input
        className={c.input}
        placeholder="Никнейм, имя или телефон +7…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        inputMode="search"
        autoFocus
      />
      <div className={s.chatList}>
        {people.map((row) => (
          <button key={row.user.id} type="button" className={s.chatRow} onClick={() => onOpen(row.user.id)}>
            <UserAvatar username={row.name} avatarUrl={row.user.avatar_url} userId={row.user.id} size="sm" />
            <span className={s.newChatMeta}>
              {row.name}
              <span className={s.newChatNick}>@{row.user.username}</span>
            </span>
          </button>
        ))}
        {more.length > 0 && <p className={c.hint}>Найдены в Quazar</p>}
        {more.map((u) => (
          <button key={u.id} type="button" className={s.chatRow} onClick={() => onOpen(u.id)}>
            <UserAvatar username={displayName(u)} avatarUrl={u.avatar_url} userId={u.id} size="sm" />
            <span className={s.newChatMeta}>
              {displayName(u)}
              <span className={s.newChatNick}>@{u.username}</span>
            </span>
          </button>
        ))}
        {searching && <p className={c.hint}>Поиск…</p>}
        {!searching && people.length === 0 && more.length === 0 && (
          <p className={c.hint}>
            {query.trim() ? "Никого не нашлось" : "Найдите человека по нику, имени или номеру телефона"}
          </p>
        )}
      </div>
    </ChatDialog>
  );
}

import { useEffect, useState } from "react";
import { useChatStore } from "../store/chat";
import { useAuthStore } from "../store/auth";
import { usersApi } from "../api/users";
import type { User } from "../api/types";
import s from "./ChatList.module.css";

export default function ChatList() {
  const { chats, activeChatId, loadChats, selectChat, openDirectChat } = useChatStore();
  const currentUser = useAuthStore((s) => s.user);

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const users = await usersApi.search(search);
        setResults(users);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const chatName = (chat: typeof chats[0]) => {
    if (chat.type === "group") return chat.name ?? "Группа";
    const other = chat.members.find((m) => m.user.id !== currentUser?.id);
    return other?.user.username ?? "Неизвестный";
  };

  const handleUserClick = async (user: User) => {
    setSearch("");
    setResults([]);
    await openDirectChat(user.id);
  };

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Quazar</span>
      </div>

      <div className={s.searchBox}>
        <input
          className={s.search}
          placeholder="Найти пользователя..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search.length >= 2 && (
          <div className={s.dropdown}>
            {searching && <div className={s.hint}>Поиск...</div>}
            {!searching && results.length === 0 && <div className={s.hint}>Никого не найдено</div>}
            {results.map((u) => (
              <button key={u.id} className={s.userResult} onClick={() => handleUserClick(u)}>
                <span className={s.avatar}>{u.username[0].toUpperCase()}</span>
                {u.username}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={s.list}>
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={chat.id === activeChatId ? s.activeItem : s.item}
            onClick={() => selectChat(chat.id)}
          >
            <span className={s.avatar}>{chatName(chat)[0].toUpperCase()}</span>
            <span className={s.name}>{chatName(chat)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

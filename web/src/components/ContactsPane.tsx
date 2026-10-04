import { useEffect, useMemo, useState } from "react";
import { usersApi } from "../api/users";
import type { User } from "../api/types";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { useUiStore } from "../store/ui";
import UserAvatar from "./UserAvatar";
import { IconSearch, IconStar } from "./icons";
import s from "./ContactsPane.module.css";

type Filter = "all" | "favorites";

export default function ContactsPane() {
  const { chats, activeChatId, loadChats, selectChat, openDirectChat, messages } =
    useChatStore();
  const currentUser = useAuthStore((st) => st.user);
  const setMobileChatOpen = useUiStore((st) => st.setMobileChatOpen);
  const setTab = useUiStore((st) => st.setTab);
  const favoriteChatIds = useUiStore((st) => st.favoriteChatIds);
  const toggleFavorite = useUiStore((st) => st.toggleFavorite);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        try {
          setResults(await usersApi.search(search));
        } finally {
          setSearching(false);
        }
      })();
    }, 280);
    return () => clearTimeout(timer);
  }, [search]);

  const chatPeer = (chat: (typeof chats)[0]) => {
    if (chat.type === "group") {
      return { username: chat.name ?? "Группа", avatar_url: null as string | null };
    }
    const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
    return {
      username: other?.username ?? "Неизвестный",
      avatar_url: other?.avatar_url ?? null,
    };
  };

  const lastPreview = (chatId: string) => {
    const list = messages[chatId];
    if (!list?.length) return "Нет сообщений";
    const last = list[list.length - 1];
    if (last.payload.startsWith("Сообщение недоступно")) return "🔒 зашифровано";
    return last.payload;
  };

  const lastTime = (chatId: string, fallback: string) => {
    const list = messages[chatId];
    const ts = list?.length ? list[list.length - 1].created_at : fallback;
    return new Date(ts).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  };

  const filtered = useMemo(() => {
    if (filter === "favorites") {
      return chats.filter((c) => favoriteChatIds.includes(c.id));
    }
    return chats;
  }, [chats, filter, favoriteChatIds]);

  const openChat = async (chatId: string) => {
    await selectChat(chatId);
    setTab("chats");
    setMobileChatOpen(true);
  };

  return (
    <div className={s.root}>
      <div className={s.header}>
        <h2 className={s.title}>Контакты</h2>
      </div>

      <div className={s.searchWrap}>
        <IconSearch />
        <input
          className={s.search}
          placeholder="Поиск"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className={s.filters}>
        <button
          type="button"
          className={filter === "all" ? s.chipActive : s.chip}
          onClick={() => setFilter("all")}
        >
          Все {chats.length}
        </button>
        <button
          type="button"
          className={filter === "favorites" ? s.chipActive : s.chip}
          onClick={() => setFilter("favorites")}
        >
          Избранные
        </button>
      </div>

      {search.length >= 2 && (
        <div className={s.searchSection}>
          {searching && <div className={s.hint}>Поиск...</div>}
          {!searching && results.length === 0 && (
            <div className={s.hint}>Никого не найдено</div>
          )}
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              className={s.userResult}
              onClick={() => {
                void (async () => {
                  setSearch("");
                  await openDirectChat(u.id);
                  setTab("chats");
                  setMobileChatOpen(true);
                })();
              }}
            >
              <UserAvatar username={u.username} avatarUrl={u.avatar_url} size="sm" />
              {u.username}
            </button>
          ))}
        </div>
      )}

      <div className={s.list}>
        {filtered.length === 0 && (
          <div className={s.hint}>
            {filter === "favorites"
              ? "Нет избранных чатов — отметьте звездой"
              : "Найдите пользователя в поиске, чтобы начать чат"}
          </div>
        )}
        {filtered.map((chat) => {
          const peer = chatPeer(chat);
          const fav = favoriteChatIds.includes(chat.id);
          return (
            <button
              key={chat.id}
              type="button"
              className={chat.id === activeChatId ? s.itemActive : s.item}
              onClick={() => void openChat(chat.id)}
            >
              <UserAvatar username={peer.username} avatarUrl={peer.avatar_url} />
              <div className={s.meta}>
                <div className={s.nameRow}>
                  <span className={s.name}>{peer.username}</span>
                </div>
                <span className={s.preview}>{lastPreview(chat.id)}</span>
              </div>
              <div className={s.aside}>
                <span className={s.time}>{lastTime(chat.id, chat.created_at)}</span>
                <span
                  className={fav ? `${s.starBtn} ${s.starBtnOn}` : s.starBtn}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(chat.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      toggleFavorite(chat.id);
                    }
                  }}
                >
                  <IconStar size={15} />
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

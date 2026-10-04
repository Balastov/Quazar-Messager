import { useEffect, useMemo, useState } from "react";
import { usersApi } from "../api/users";
import type { User } from "../api/types";
import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import { useUiStore } from "../store/ui";
import { useUnreadStore } from "../store/unread";
import {
  canSearchUsers,
  extractRuLocalDigits,
  formatRuPhoneDisplay,
  formatRuPhoneMask,
  looksLikePhoneQuery,
} from "../utils/phone";
import {
  isContactPickerSupported,
  pickPhoneFromDeviceContacts,
} from "../utils/contactsPicker";
import UserAvatar from "./UserAvatar";
import { IconAddressBook, IconSearch, IconStar } from "./icons";
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
  const unreadCounts = useUnreadStore((st) => st.counts);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickerHint, setPickerHint] = useState<string | null>(null);
  const contactPickerOk = isContactPickerSupported();

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (!canSearchUsers(search)) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        try {
          setResults(await usersApi.search(search.trim()));
        } finally {
          setSearching(false);
        }
      })();
    }, 280);
    return () => clearTimeout(timer);
  }, [search]);

  const chatPeer = (chat: (typeof chats)[0]) => {
    if (chat.type === "group") {
      return {
        username: chat.name ?? "Группа",
        avatar_url: null as string | null,
        phone: null as string | null,
      };
    }
    const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
    return {
      username: other?.username ?? "Неизвестный",
      avatar_url: other?.avatar_url ?? null,
      phone: other?.phone ?? null,
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
    let list = chats;
    if (filter === "favorites") {
      list = list.filter((c) => favoriteChatIds.includes(c.id));
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    const digits = extractRuLocalDigits(search);
    return list.filter((c) => {
      const peer = chatPeer(c);
      if (peer.username.toLowerCase().includes(q)) return true;
      if (digits.length >= 3 && peer.phone?.includes(digits)) return true;
      return false;
    });
    // chatPeer depends on currentUser; chats/messages identity is enough here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, filter, favoriteChatIds, search, currentUser?.id]);

  const openChat = async (chatId: string) => {
    await selectChat(chatId);
    setTab("chats");
    setMobileChatOpen(true);
  };

  const pickFromPhone = async () => {
    setPickerHint(null);
    if (!contactPickerOk) {
      setPickerHint(
        "Выбор из контактов телефона доступен в Chrome на Android. Введите номер вручную."
      );
      return;
    }
    const picked = await pickPhoneFromDeviceContacts();
    if (!picked?.tel) {
      setPickerHint(picked === null ? null : "У контакта нет номера телефона");
      return;
    }
    const digits = extractRuLocalDigits(picked.tel);
    if (digits.length < 3) {
      setPickerHint("Не удалось распознать номер контакта");
      return;
    }
    setSearch(digits.length === 10 ? formatRuPhoneMask(picked.tel) : picked.tel);
  };

  const showSearchPanel = canSearchUsers(search);

  return (
    <div className={s.root}>
      <div className={s.header}>
        <h2 className={s.title}>Контакты</h2>
      </div>

      <div className={s.searchRow}>
        <div className={s.searchWrap}>
          <IconSearch />
          <input
            className={s.search}
            placeholder="Имя или телефон +7…"
            value={search}
            onChange={(e) => {
              const raw = e.target.value;
              // Автомаска, если похоже на набор номера
              if (looksLikePhoneQuery(raw) || /^[+78(]/.test(raw.trim())) {
                const d = extractRuLocalDigits(raw);
                setSearch(d.length ? formatRuPhoneMask(raw) : raw);
              } else {
                setSearch(raw);
              }
            }}
            inputMode="search"
          />
        </div>
        <button
          type="button"
          className={s.bookBtn}
          title={
            contactPickerOk
              ? "Выбрать из контактов телефона"
              : "Контакты телефона: Chrome на Android"
          }
          onClick={() => void pickFromPhone()}
        >
          <IconAddressBook />
        </button>
      </div>
      {pickerHint && <div className={s.pickerHint}>{pickerHint}</div>}

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

      {showSearchPanel && (
        <div className={s.searchSection}>
          {searching && <div className={s.hint}>Поиск...</div>}
          {!searching && results.length === 0 && (
            <div className={s.hint}>
              {looksLikePhoneQuery(search)
                ? "Нет пользователя Quazar с таким номером"
                : "Никого не найдено"}
            </div>
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
              <span className={s.userMeta}>
                <span className={s.userName}>{u.username}</span>
                <span className={s.userPhone}>{formatRuPhoneDisplay(u.phone)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className={s.list}>
        {filtered.length === 0 && (
          <div className={s.hint}>
            {filter === "favorites"
              ? "Нет избранных чатов — отметьте звездой"
              : "Найдите пользователя по имени или телефону"}
          </div>
        )}
        {filtered.map((chat) => {
          const peer = chatPeer(chat);
          const fav = favoriteChatIds.includes(chat.id);
          const unread = unreadCounts[chat.id] ?? 0;
          const hasUnread = unread > 0;
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
                  <span className={hasUnread ? s.nameUnread : s.name}>{peer.username}</span>
                </div>
                <span className={hasUnread ? s.previewUnread : s.preview}>
                  {lastPreview(chat.id)}
                </span>
              </div>
              <div className={s.aside}>
                <span className={hasUnread ? s.timeUnread : s.time}>
                  {lastTime(chat.id, chat.created_at)}
                </span>
                {hasUnread ? (
                  <span className={s.badge}>{unread > 99 ? "99+" : unread}</span>
                ) : (
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
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

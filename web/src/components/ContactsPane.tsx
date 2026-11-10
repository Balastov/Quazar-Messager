import { useEffect, useMemo, useState } from "react";
import PremiumBadge from "./premium/PremiumBadge";
import { usersApi } from "../api/users";
import type { User } from "../api/types";
import { useAuthStore } from "../store/auth";
import { SAVED_CHAT_TITLE, useChatStore } from "../store/chat";
import { useUiStore } from "../store/ui";
import { useUnreadStore } from "../store/unread";
import { chatLevel, useNotifyStore } from "../notifications/levels";
import CustomStatusBadge from "./status/CustomStatusBadge";
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
import { messagePreview, useStickersStore } from "../store/stickers";
import { useContactsStore } from "../store/contacts";
import { chatTypingKey, useTyping } from "../store/typing";
import { typingLabel } from "../chat/typing";
import type { Chat } from "../api/types";
import m from "./messages/Messages.module.css";
import SavedAvatar from "./chat/SavedAvatar";
import SupportAvatar from "./support/SupportAvatar";
import OfficialBadge from "./support/OfficialBadge";
import { displayName } from "../utils/profile";
import { listTimestamp } from "../chat/listTimestamp";
import UnreadBadge from "./chat/UnreadBadge";
import { showOpenedChat } from "../chat/showOpenedChat";

/** Строка под именем чата: последнее сообщение, а пока кто-то набирает — «печатает…». */
function PreviewLine({ chat, className, children }: { chat: Chat; className: string; children: string }) {
  const typing = useTyping(chatTypingKey(chat.id));
  if (!typing.length) return <span className={className}>{children}</span>;
  const label =
    chat.type === "group"
      ? typingLabel(typing.map((id) => displayName(chat.members.find((mb) => mb.user.id === id)?.user) ?? "Кто-то"))
      : "печатает…";
  return <span className={`${className} ${m.typing}`}>{label}</span>;
}

type Filter = "all" | "favorites" | "phonebook";

export default function ContactsPane() {
  const { chats, activeChatId, loadChats, selectChat, openDirectChat, openSavedChat, messages } =
    useChatStore();
  const currentUser = useAuthStore((st) => st.user);
  // Превью «Стикер 😂» обновится, когда загрузится каталог стикеров.
  useStickersStore((st) => st.loaded);
  const favoriteChatIds = useUiStore((st) => st.favoriteChatIds);
  const toggleFavorite = useUiStore((st) => st.toggleFavorite);
  const unreadCounts = useUnreadStore((st) => st.counts);
  const unreadMentions = useUnreadStore((st) => st.mentions);
  const notifySettings = useNotifyStore((st) => st.settings);
  // Найденные в телефонной книге (синхронизирует мобильное приложение).
  const phonebook = useContactsStore((st) => st.contacts);
  const phonebookNames = useContactsStore((st) => st.names);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickerHint, setPickerHint] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const current = new Date(); setNow(current); clearTimeout(timer);
      const tomorrow = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
      timer = setTimeout(refresh, tomorrow.getTime() - current.getTime() + 25);
    };
    refresh(); window.addEventListener("focus", refresh);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, []);
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
    if (chat.type === "group" || chat.type === "saved") {
      return {
        id: null as string | null,
        username: chat.type === "saved" ? SAVED_CHAT_TITLE : (chat.name ?? "Группа"),
        avatar_url: null as string | null,
        phone: null as string | null,
      };
    }
    const other = chat.members.find((m) => m.user.id !== currentUser?.id)?.user;
    return {
      id: other?.id ?? null,
      // Как человек записан в телефонной книге — так и показываем.
      username: (other && phonebookNames[other.id]) || displayName(other) || "Неизвестный",
      avatar_url: other?.avatar_url ?? null,
      phone: other?.phone ?? null,
      premium: !!other?.is_premium,
    };
  };

  // Последнее сообщение: из открытой ленты, а если чат ещё не открывали — из списка чатов.
  const lastMessage = (chat: Chat) => {
    const list = messages[chat.id];
    const cached = list?.length ? list[list.length - 1] : null;
    const server = chat.last_message;
    if (!cached) return server ?? null;
    return server && Date.parse(server.created_at) > Date.parse(cached.created_at) ? server : cached;
  };

  const lastPreview = (chat: Chat) => {
    const last = lastMessage(chat);
    if (!last) return "Нет сообщений";
    if (last.payload.startsWith("Сообщение недоступно")) return "🔒 зашифровано";
    return messagePreview(last.payload);
  };

  const lastTime = (chat: Chat) => {
    const ts = lastMessage(chat)?.created_at;
    return ts ? listTimestamp(ts, now) : "";
  };

  const savedChat = chats.find((c) => c.type === "saved");
  const showSaved =
    filter === "all" &&
    (!search.trim() || SAVED_CHAT_TITLE.toLowerCase().includes(search.trim().toLowerCase()));

  const filtered = useMemo(() => {
    // «Записная книжка» — отдельной строкой сверху.
    let list = chats.filter((c) => c.type !== "saved");
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
  }, [chats, filter, favoriteChatIds, search, currentUser?.id, phonebookNames]);

  const phonebookFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return phonebook;
    return phonebook.filter(
      (c) => c.name.toLowerCase().includes(q) || c.user.username.toLowerCase().includes(q) || displayName(c.user).toLowerCase().includes(q)
    );
  }, [phonebook, search]);

  const openContact = async (userId: string) => {
    setSearch("");
    await showOpenedChat(() => openDirectChat(userId));
  };

  const openChat = (chatId: string) => showOpenedChat(() => selectChat(chatId));

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
            placeholder="Никнейм, имя или телефон +7…"
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
        {phonebook.length > 0 && (
          <button
            type="button"
            className={filter === "phonebook" ? s.chipActive : s.chip}
            onClick={() => setFilter("phonebook")}
            title="Кто из контактов вашего телефона уже в Quazar"
          >
            Из телефона {phonebook.length}
          </button>
        )}
      </div>

      {showSearchPanel && (
        <div className={s.searchSection}>
          {searching && <div className={s.hint}>Поиск...</div>}
          {!searching && results.length === 0 && (
            <div className={s.hint}>
              {!looksLikePhoneQuery(search)
                ? "Никого не найдено"
                : extractRuLocalDigits(search).length < 10
                  ? "Введите номер целиком — по части номера не ищем"
                  : "По этому номеру никого не нашли. Человек мог скрыть номер — попробуйте никнейм или имя"}
            </div>
          )}
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              className={s.userResult}
              onClick={() => {
                setSearch("");
                void showOpenedChat(() => openDirectChat(u.id));
              }}
            >
              <UserAvatar username={displayName(u)} avatarUrl={u.avatar_url} size="sm" userId={u.id} />
              <span className={s.userMeta}>
                <span className={s.userName}>{displayName(u)}</span>
                <span className={s.userPhone}>@{u.username}
                  {u.phone && ` · ${formatRuPhoneDisplay(u.phone)}`}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {filter === "phonebook" ? (
        <div className={s.list}>
          {phonebookFiltered.length === 0 && <div className={s.hint}>Никого не найдено</div>}
          {phonebookFiltered.map((c) => (
            <button
              key={c.user.id}
              type="button"
              className={s.item}
              onClick={() => void openContact(c.user.id)}
            >
              <UserAvatar
                username={c.name || displayName(c.user)}
                avatarUrl={c.user.avatar_url}
                userId={c.user.id}
              />
              <div className={s.meta}>
                <div className={s.nameRow}>
                  <span className={s.name}>{c.name || displayName(c.user)}</span>
                </div>
                <span className={s.preview}>
                  @{c.user.username}
                  {c.user.phone && ` · ${formatRuPhoneDisplay(c.user.phone)}`}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : (
      <div className={s.list}>
        {showSaved && (
          <button
            type="button"
            className={savedChat && savedChat.id === activeChatId ? s.itemActive : s.item}
            onClick={() => void showOpenedChat(openSavedChat)}
          >
            <SavedAvatar />
            <div className={s.meta}>
              <div className={s.nameRow}>
                <span className={s.name}>{SAVED_CHAT_TITLE}</span>
              </div>
              <span className={s.preview}>
                {savedChat && lastMessage(savedChat)
                  ? lastPreview(savedChat)
                  : "Заметки и пересланное"}
              </span>
            </div>
          </button>
        )}
        {filtered.length === 0 && !showSaved && (
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
          const quiet = chat.type !== "saved" && chatLevel(notifySettings, chat.id) === "none";
          return (
            <button
              key={chat.id}
              type="button"
              className={chat.id === activeChatId ? s.itemActive : s.item}
              onClick={() => void openChat(chat.id)}
            >
              {chat.type === "support" || chat.type === "news" ? (
                <SupportAvatar kind={chat.type === "news" ? "news" : "support"} />
              ) : (
                <UserAvatar username={displayName(peer)} avatarUrl={peer.avatar_url} userId={peer.id} />
              )}
              <div className={s.meta}>
                <div className={s.nameRow}>
                  <span className={hasUnread ? s.nameUnread : s.name}>{displayName(peer)}</span>
                  {(chat.type === "support" || chat.type === "news") && <OfficialBadge />}
                  {chat.type === "direct" && "premium" in peer && peer.premium && <PremiumBadge />}
                  {chat.type === "direct" && <CustomStatusBadge userId={peer.id} compact />}
                  {quiet && (
                    <span title="Уведомления выключены" aria-label="Уведомления выключены">
                      🔕
                    </span>
                  )}
                </div>
                <PreviewLine chat={chat} className={hasUnread ? s.previewUnread : s.preview}>
                  {lastPreview(chat)}
                </PreviewLine>
              </div>
              <div className={s.aside}>
                <span className={hasUnread ? s.timeUnread : s.time}>
                  {lastTime(chat)}
                </span>
                {hasUnread ? (
                  <UnreadBadge count={unread} mentions={unreadMentions[chat.id] ?? 0} quiet={quiet} />
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
      )}
    </div>
  );
}

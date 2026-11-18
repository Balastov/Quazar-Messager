/** Списки на главном экране: «Чат» — переписки по свежести, «Контакты» — люди по алфавиту. */
import type { Chat, Message, User } from "../api/types";
import type { QuazarContact } from "../api/contacts";
import { compareNames, displayName } from "../utils/profile";

/**
 * «Чат»: переписки, сверху — с самым свежим сообщением. Личный чат без сообщений (открыли профиль
 * и ничего не написали) не показываем — человек есть в «Контактах». Новую группу без сообщений
 * показываем: она не должна пропадать сразу после создания. «Записная книжка» — отдельно, сверху,
 * под ней — закреплённые (в порядке закрепления), даже если сообщений в них ещё нет.
 */
export function chatsByLastMessage(chats: Chat[], lastMessage: (chat: Chat) => Message | null,
  pinnedIds: readonly string[] = []): Chat[] {
  const at = (chat: Chat) => {
    const last = lastMessage(chat);
    return Date.parse(last?.created_at ?? chat.created_at) || 0;
  };
  const pinned = new Set(pinnedIds);
  const sorted = chats
    .filter((chat) => chat.type !== "saved" && (chat.type === "group" || pinned.has(chat.id) || !!lastMessage(chat)))
    .sort((a, b) => at(b) - at(a));
  return pinnedFirst(sorted, pinnedIds, (chat) => chat.id);
}

export interface ContactRow {
  user: User;
  /** Как показываем: имя из телефонной книги, иначе имя в Quazar, иначе никнейм. */
  name: string;
  /** Личный чат с ним (или чат с ботом), если уже есть. */
  chatId: string | null;
  /** Системный бот Quazar: поддержка или новости — открываем его чат, а не личный. */
  bot: "support" | "news" | null;
}

/**
 * «Контакты»: люди из личных чатов (даже без сообщений), найденные в телефонной книге и системные
 * боты Quazar — без групп и «Записной книжки» (она отдельно, сверху); от А до Я по имени,
 * без имени — по никнейму. Закреплённые — сверху, в порядке закрепления.
 */
export function contactRows(chats: Chat[], phonebook: QuazarContact[], myId: string | undefined,
  phonebookNames: Record<string, string>, pinnedIds: readonly string[] = []): ContactRow[] {
  const rows = new Map<string, ContactRow>();
  const add = (user: User, chatId: string | null, bot: ContactRow["bot"]) => {
    if (!user || user.id === myId) return;
    const known = rows.get(user.id);
    if (known) {
      known.chatId ??= chatId;
      return;
    }
    rows.set(user.id, { user, name: phonebookNames[user.id] || displayName(user), chatId, bot });
  };
  for (const chat of chats) {
    const bot = chat.type === "support" || chat.type === "news" ? chat.type : null;
    if (chat.type !== "direct" && !bot) continue;
    const other = chat.members.find((m) => m.user.id !== myId)?.user;
    if (other && (bot || !other.is_official)) add(other, chat.id, bot);
  }
  for (const contact of phonebook) if (!contact.user.is_official) add(contact.user, null, null);
  const sorted = [...rows.values()].sort((a, b) => compareNames(a.name, b.name) || compareNames(a.user.username, b.user.username));
  return pinnedFirst(sorted, pinnedIds, (row) => row.user.id);
}

/** Закреплённые — сверху, в порядке закрепления; остальные — как были. */
export function pinnedFirst<T>(items: T[], pinnedIds: readonly string[], idOf: (item: T) => string | null): T[] {
  if (!pinnedIds.length) return items;
  const rank = new Map(pinnedIds.map((id, i) => [id, i]));
  const top = items.filter((item) => rank.has(idOf(item) ?? "")).sort((a, b) => rank.get(idOf(a)!)! - rank.get(idOf(b)!)!);
  return [...top, ...items.filter((item) => !rank.has(idOf(item) ?? ""))];
}

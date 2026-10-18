import { http } from "./client";
import type { User } from "./types";

export interface QuazarContact {
  user: User;
  /** Как человек записан в телефонной книге. */
  name: string;
}

export interface ContactsOut {
  synced_at: string | null;
  /** Сколько записей было в книге при последней синхронизации. */
  total: number;
  contacts: QuazarContact[];
}

export interface PhonebookEntry {
  name: string;
  phones: string[];
}

/**
 * Веб (PWA) присылает часть книги — выбранные контакты или файл .vcf — в режиме merge:
 * найденные добавляются к списку. Мобильное приложение шлёт книгу целиком (replace).
 */
export const contactsApi = {
  mine: () => http.get<ContactsOut>("/contacts").then((r) => r.data),
  merge: (contacts: PhonebookEntry[]) =>
    http.post<ContactsOut>("/contacts/sync", { contacts, mode: "merge" }).then((r) => r.data),
  forget: () => http.delete("/contacts"),
};

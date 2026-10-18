import { create } from "zustand";
import axios from "axios";
import { contactsApi, type ContactsOut, type PhonebookEntry, type QuazarContact } from "../api/contacts";
import { socket } from "../ws/socket";

/** Столько контактов сервер принимает за один раз. */
const CHUNK = 5000;

export interface ImportResult {
  checked: number;
  /** Сколько человек добавилось в список «Из телефона». */
  added: number;
}

interface ContactsState {
  contacts: QuazarContact[];
  /** user_id → имя из телефонной книги. */
  names: Record<string, string>;
  syncedAt: string | null;
  total: number;
  /** Список уже запрашивали с сервера (до этого не предлагаем импорт). */
  loaded: boolean;
  importing: boolean;
  load: () => Promise<void>;
  /** Выбранные контакты или файл .vcf: сверка и добавление найденных. */
  importContacts: (entries: PhonebookEntry[]) => Promise<ImportResult>;
  forget: () => Promise<void>;
}

let unsubscribe: (() => void) | null = null;

function fromOut(out: ContactsOut) {
  return {
    contacts: out.contacts,
    names: Object.fromEntries(out.contacts.map((c) => [c.user.id, c.name])),
    syncedAt: out.synced_at,
    total: out.total,
  };
}

export function importErrorText(err: unknown): string {
  if (axios.isAxiosError(err) && err.response?.status === 429) {
    return "Контакты загружали слишком часто — попробуйте через час";
  }
  return "Не удалось сверить контакты. Проверьте интернет и попробуйте ещё раз.";
}

export const useContactsStore = create<ContactsState>((set, get) => ({
  contacts: [],
  names: {},
  syncedAt: null,
  total: 0,
  loaded: false,
  importing: false,

  load: async () => {
    // Список обновили с другого устройства — сервер сообщает, перечитываем.
    unsubscribe ??= socket.on((event) => {
      if ((event as { type?: string }).type === "contacts_updated") void get().load();
    });
    try {
      set({ ...fromOut(await contactsApi.mine()), loaded: true });
    } catch {
      // Покажем то, что есть.
    }
  },

  importContacts: async (entries) => {
    const before = new Set(get().contacts.map((c) => c.user.id));
    set({ importing: true });
    try {
      let out: ContactsOut | null = null;
      for (let i = 0; i < entries.length; i += CHUNK) {
        out = await contactsApi.merge(entries.slice(i, i + CHUNK));
      }
      if (out) set(fromOut(out));
      const added = (out?.contacts ?? []).filter((c) => !before.has(c.user.id)).length;
      return { checked: entries.length, added };
    } finally {
      set({ importing: false });
    }
  },

  forget: async () => {
    await contactsApi.forget();
    set({ contacts: [], names: {}, syncedAt: null, total: 0 });
  },
}));

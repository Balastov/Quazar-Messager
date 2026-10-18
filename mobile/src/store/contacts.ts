/**
 * Контакты из телефонной книги.
 *
 * - При первом входе приложение спрашивает, можно ли сверить книгу (pref = 'unasked').
 * - Разрешили — книга сверяется сразу и потом сама: при запуске и возвращении в приложение,
 *   не чаще раза в SYNC_INTERVAL_MS.
 * - Отказали — переключатель остаётся в профиле.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import {contactsApi, type QuazarContact} from '../api/contacts';
import {
  phonebookPermission,
  readPhonebook,
  requestPhonebookPermission,
  type PhonebookPermission,
} from '../contacts/phonebook';

export const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;

type Pref = 'unasked' | 'on' | 'off';

interface ContactsState {
  pref: Pref;
  /** Последняя успешная сверка с этого устройства (мс). */
  lastSyncAt: number | null;
  contacts: QuazarContact[];
  /** Сколько записей в книге было при последней сверке. */
  total: number;
  syncing: boolean;
  error: string | null;
  /** Доступ к книге закрыт в настройках системы — нужно открыть их. */
  blocked: boolean;

  /** Список найденных с сервера (его видно и на других устройствах). */
  load: () => Promise<void>;
  /** «Разрешить»: системный запрос и первая сверка. */
  enable: () => Promise<PhonebookPermission>;
  /** «Не сейчас» в первом вопросе. */
  decline: () => void;
  /** Выключить в профиле: перестаём сверять и стираем найденных с сервера. */
  disable: () => Promise<void>;
  syncNow: () => Promise<void>;
  /** Тихая сверка по расписанию (запуск, возвращение в приложение). */
  maybeSync: () => Promise<void>;
  reset: () => void;
}

let running: Promise<void> | null = null;

export const useContactsStore = create<ContactsState>()(
  persist(
    (set, get) => {
      const runSync = (): Promise<void> => {
        running ??= (async () => {
          set({syncing: true, error: null});
          try {
            const entries = await readPhonebook();
            const out = await contactsApi.sync(entries);
            set({contacts: out.contacts, total: out.total, lastSyncAt: Date.now(), blocked: false});
          } catch (err) {
            const status = (err as {response?: {status?: number}})?.response?.status;
            set({
              error:
                status === 429
                  ? 'Контакты обновлялись слишком часто — попробуйте позже'
                  : 'Не удалось обновить контакты',
            });
          } finally {
            set({syncing: false});
            running = null;
          }
        })();
        return running;
      };

      return {
        pref: 'unasked',
        lastSyncAt: null,
        contacts: [],
        total: 0,
        syncing: false,
        error: null,
        blocked: false,

        load: async () => {
          try {
            const out = await contactsApi.mine();
            set({contacts: out.contacts, total: out.total});
          } catch {
            // Покажем то, что уже есть.
          }
        },

        enable: async () => {
          let permission = await phonebookPermission();
          if (permission !== 'granted') {
            permission = await requestPhonebookPermission();
          }
          if (permission !== 'granted') {
            set({pref: 'off', blocked: permission === 'blocked'});
            return permission;
          }
          set({pref: 'on', blocked: false});
          await runSync();
          return permission;
        },

        decline: () => set({pref: 'off'}),

        disable: async () => {
          set({pref: 'off', contacts: [], total: 0, lastSyncAt: null, error: null});
          await contactsApi.forget().catch(() => {});
        },

        syncNow: async () => {
          if ((await phonebookPermission()) !== 'granted') {
            set({blocked: true});
            return;
          }
          await runSync();
        },

        maybeSync: async () => {
          const {pref, lastSyncAt} = get();
          if (pref !== 'on') {
            return;
          }
          if (lastSyncAt && Date.now() - lastSyncAt < SYNC_INTERVAL_MS) {
            return;
          }
          // Доступ могли забрать в настройках системы — тогда молча ждём, в профиле подскажем.
          if ((await phonebookPermission()) !== 'granted') {
            set({blocked: true});
            return;
          }
          await runSync();
        },

        reset: () =>
          set({pref: 'unasked', lastSyncAt: null, contacts: [], total: 0, error: null, blocked: false}),
      };
    },
    {
      name: 'quazar-contacts',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: st => ({pref: st.pref, lastSyncAt: st.lastSyncAt, contacts: st.contacts, total: st.total}),
    },
  ),
);

/** Имя из телефонной книги для пользователя, если он там есть. */
export function contactName(userId: string | undefined): string | undefined {
  if (!userId) {
    return undefined;
  }
  return useContactsStore.getState().contacts.find(c => c.user.id === userId)?.name;
}

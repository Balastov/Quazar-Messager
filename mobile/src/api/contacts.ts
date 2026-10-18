import {http} from './client';
import type {User} from './types';

export interface PhonebookEntry {
  name: string;
  phones: string[];
}

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

export const contactsApi = {
  mine: () => http.get<ContactsOut>('/contacts').then(r => r.data),
  /** Книга целиком: сервер сохранит только найденных пользователей Quazar. */
  sync: (contacts: PhonebookEntry[]) =>
    http.post<ContactsOut>('/contacts/sync', {contacts}).then(r => r.data),
  forget: () => http.delete('/contacts'),
};

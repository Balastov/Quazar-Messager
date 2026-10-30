import {http} from './client';
import type {User} from './types';
import {compareNames, displayName} from '../utils/profile';

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

function sortedContacts(out: ContactsOut): ContactsOut {
  return {...out, contacts: [...out.contacts].sort((a, b) =>
    compareNames(a.name.trim() || displayName(a.user), b.name.trim() || displayName(b.user)),
  )};
}

export const contactsApi = {
  mine: () => http.get<ContactsOut>('/contacts').then(r => sortedContacts(r.data)),
  /** Книга целиком: сервер сохранит только найденных пользователей Quazar. */
  sync: (contacts: PhonebookEntry[]) =>
    http.post<ContactsOut>('/contacts/sync', {contacts}).then(r => sortedContacts(r.data)),
  forget: () => http.delete('/contacts'),
};

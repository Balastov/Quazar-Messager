import {http} from './client';
import type {User} from './types';

export const usersApi = {
  /** «На встрече» / «Не беспокоить» с таймером; kind=null — снять. */
  setStatus: (body: {kind: 'meeting' | 'dnd' | null; until: string | null}) =>
    http.put('/users/me/status', body).then(r => r.data),
  me: () => http.get<User>('/users/me').then(r => r.data),
  search: (q: string) => http.get<User[]>('/users/search', {params: {q}}).then(r => r.data),
};

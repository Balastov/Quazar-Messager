import {http} from './client';
import type {User} from './types';
import {compareUsers} from '../utils/profile';

export const usersApi = {
  /** «На встрече» / «Не беспокоить» с таймером; kind=null — снять. */
  setStatus: (body: {kind: 'meeting' | 'dnd' | null; until: string | null}) =>
    http.put('/users/me/status', body).then(r => r.data),
  me: () => http.get<User>('/users/me').then(r => r.data),
  /** Никнейм, почта, имя, фамилия; не присланное не меняется, '' — убрать. */
  updateMe: (body: Partial<Pick<User, 'username' | 'email' | 'first_name' | 'last_name' | 'phone_discoverable'>>) =>
    http.patch<User>('/users/me', body).then(r => r.data),
  search: (q: string) => http.get<User[]>('/users/search', {params: {q}}).then(r => [...r.data].sort(compareUsers)),
};

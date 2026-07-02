import {http} from './client';
import type {Chat} from './types';

export const chatsApi = {
  list: () => http.get<Chat[]>('/chats').then(r => r.data),
  get: (id: string) => http.get<Chat>(`/chats/${id}`).then(r => r.data),
  createDirect: (userId: string) =>
    http.post<Chat>('/chats/direct', {user_id: userId}).then(r => r.data),
  createGroup: (name: string, memberIds: string[]) =>
    http.post<Chat>('/chats/group', {name, member_ids: memberIds}).then(r => r.data),
};

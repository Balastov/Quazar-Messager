import { http } from "./client";
import type { Chat } from "./types";

export const chatsApi = {
  list: () => http.get<Chat[]>("/chats").then((r) => r.data),

  get: (chatId: string) => http.get<Chat>(`/chats/${chatId}`).then((r) => r.data),

  createDirect: (userId: string) =>
    http.post<Chat>("/chats/direct", { user_id: userId }).then((r) => r.data),

  createGroup: (name: string, memberIds: string[]) =>
    http.post<Chat>("/chats/group", { name, member_ids: memberIds }).then((r) => r.data),

  /** payload — «IMG1:{…}» (в личных чатах уже зашифрованный), картинка — во вложении. */
  setBackground: (chatId: string, payload: string, attachmentId: string) =>
    http.put(`/chats/${chatId}/background`, { payload, attachment_id: attachmentId }),

  removeBackground: (chatId: string) => http.delete(`/chats/${chatId}/background`),

  /** «Записная книжка»: создаётся при первом открытии. */
  openSaved: () => http.post<Chat>("/chats/saved").then((r) => r.data),

  /** Исчезающие сообщения: 3600 / 86400 / 604800 секунд или null — выключить. */
  setTtl: (chatId: string, ttlSeconds: number | null) =>
    http.put(`/chats/${chatId}/ttl`, { ttl_seconds: ttlSeconds }),
};

import { http } from "./client";
import type { Message } from "./types";

const base = (chatId: string) => `/chats/${chatId}/messages`;

export const messagesApi = {
  list: (chatId: string, beforeId?: string) =>
    http
      .get<Message[]>(base(chatId), {
        params: beforeId ? { before_id: beforeId } : undefined,
      })
      .then((r) => r.data),

  send: (chatId: string, payload: string, attachmentId?: string, replyToId?: string) =>
    http
      .post<Message>(base(chatId), {
        payload,
        attachment_id: attachmentId,
        reply_to_id: replyToId,
      })
      .then((r) => r.data),

  edit: (chatId: string, messageId: string, payload: string) =>
    http.patch<Message>(`${base(chatId)}/${messageId}`, { payload }).then((r) => r.data),

  /** Удалить у всех. */
  remove: (chatId: string, messageId: string) => http.delete(`${base(chatId)}/${messageId}`),

  /** Удалить у меня. */
  hide: (chatId: string, messageId: string) => http.post(`${base(chatId)}/${messageId}/hide`),

  react: (chatId: string, messageId: string, payload: string) =>
    http.put(`${base(chatId)}/${messageId}/reaction`, { payload }),

  unreact: (chatId: string, messageId: string) =>
    http.delete(`${base(chatId)}/${messageId}/reaction`),
};

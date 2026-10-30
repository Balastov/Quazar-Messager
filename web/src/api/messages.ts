import { http } from "./client";
import type { Message } from "./types";

const base = (chatId: string) => `/chats/${chatId}/messages`;

export const messagesApi = {
  pins: (chatId: string) => http.get<Message[]>(`/chats/${chatId}/pins`).then((r) => r.data),
  pin: (chatId: string, messageId: string) => http.put(`/chats/${chatId}/pins/${messageId}`),
  unpin: (chatId: string, messageId: string) => http.delete(`/chats/${chatId}/pins/${messageId}`),
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

  /** Прежние версии исправленного сообщения, старые первыми (payload — как при отправке). */
  revisions: (chatId: string, messageId: string) =>
    http.get<{ payload: string; written_at: string }[]>(`${base(chatId)}/${messageId}/revisions`).then((r) => r.data),
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

  /** Сообщения с фото и голосовыми — для галереи, свежие первыми. */
  media: (chatId: string, beforeId?: string) =>
    http
      .get<Message[]>(`${base(chatId)}/media`, { params: beforeId ? { before_id: beforeId } : undefined })
      .then((r) => r.data),
};

export interface ScheduledMessage {
  id: string;
  chat_id: string;
  /** В личных чатах зашифрован (ENC2 — и для меня). */
  payload: string;
  reply_to_id: string | null;
  send_at: string;
  created_at: string;
}

export const scheduledApi = {
  list: (chatId: string) =>
    http.get<ScheduledMessage[]>(`/chats/${chatId}/scheduled`).then((r) => r.data),
  create: (chatId: string, payload: string, sendAt: Date, replyToId?: string) =>
    http
      .post<ScheduledMessage>(`/chats/${chatId}/scheduled`, {
        payload,
        send_at: sendAt.toISOString(),
        reply_to_id: replyToId,
      })
      .then((r) => r.data),
  cancel: (chatId: string, id: string) => http.delete(`/chats/${chatId}/scheduled/${id}`),
};

export interface Reminder {
  id: string;
  chat_id: string;
  message_id: string;
  remind_at: string;
}

export const remindersApi = {
  list: () => http.get<Reminder[]>("/reminders").then((r) => r.data),
  set: (chatId: string, messageId: string, at: Date) =>
    http
      .post<Reminder>("/reminders", { chat_id: chatId, message_id: messageId, remind_at: at.toISOString() })
      .then((r) => r.data),
  cancel: (id: string) => http.delete(`/reminders/${id}`),
};

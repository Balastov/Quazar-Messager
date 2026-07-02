import { http } from "./client";
import type { Message } from "./types";

export const messagesApi = {
  list: (chatId: string, beforeId?: string) =>
    http
      .get<Message[]>(`/chats/${chatId}/messages`, {
        params: beforeId ? { before_id: beforeId } : undefined,
      })
      .then((r) => r.data),

  send: (chatId: string, payload: string) =>
    http.post<Message>(`/chats/${chatId}/messages`, { payload }).then((r) => r.data),
};

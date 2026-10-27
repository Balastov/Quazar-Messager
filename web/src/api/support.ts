import { http } from "./client";
import type { Chat } from "./types";
import type { ImageRef } from "../attachments/image";
import type { TicketKind, TicketStatus } from "../support/ticket";

export interface Ticket {
  id: string;
  number: number;
  kind: TicketKind;
  text: string;
  images: ImageRef[];
  status: TicketStatus;
  chat_id: string;
  created_at: string;
  updated_at: string;
}

export const supportApi = {
  /** Чат с Quazar_Admin_bot — создаётся при первом обращении. */
  openChat: () => http.post<Chat>("/support/chat").then((r) => r.data),

  /** Картинки — уже загруженные во вложения чата поддержки. */
  createTicket: (body: { kind: TicketKind; text: string; images: ImageRef[] }) =>
    http.post<Ticket>("/support/tickets", body).then((r) => r.data),
};

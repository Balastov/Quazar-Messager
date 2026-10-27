import { http } from "./client";
import type { Ticket } from "./support";
import type { TicketKind, TicketStatus } from "../support/ticket";

/** «Чёрная дыра» — только для владельцев ресурса. Остальным все адреса отвечают 404. */
export interface AdminStats {
  users: number;
  online: number;
  blocked: number;
  stars: number;
  chats: number;
  messages_today: number;
  open_reports: number;
  /** Обращения в поддержку, которые ещё никто не взял. */
  queued_tickets: number;
}

export interface AdminUser {
  id: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
  phone: string;
  created_at: string | null;
  last_seen_at: string | null;
  is_superuser: boolean;
  blocked_at: string | null;
  blocked_reason: string | null;
  online: boolean;
}

export interface AdminStar {
  id: string;
  name: string;
  kind: "gaming" | "work";
  owner_id: string;
  owner_name: string | null;
  member_count: number;
  created_at: string;
  i_am_member: boolean;
}

export interface AdminReport {
  id: string;
  reporter: AdminUser | null;
  target: AdminUser | null;
  reason: string;
  comment: string | null;
  evidence: { sender: "me" | "them"; at: string; text: string }[];
  created_at: string;
  resolved_at: string | null;
}

export interface AdminTicket extends Ticket {
  author: AdminUser | null;
  /** Сообщения автора, которых команда ещё не видела. */
  unread: number;
}

export interface AdminTicketMessage {
  id: string;
  /** user — автор обращения, bot — ответ команды или служебное сообщение бота. */
  sender: "user" | "bot";
  admin: AdminUser | null;
  payload: string;
  created_at: string;
}

export interface AdminTicketDetail extends AdminTicket {
  messages: AdminTicketMessage[];
}

export type TicketFilter = "open" | "all" | TicketStatus;

export const adminApi = {
  /** Сводка; 404 — не владелец ресурса. */
  me: () => http.get<AdminStats>("/admin/me").then((r) => r.data),
  users: (params: { q?: string; filter?: "all" | "blocked" | "superusers"; before?: string }) =>
    http.get<AdminUser[]>("/admin/users", { params }).then((r) => r.data),
  block: (userId: string, reason: string) =>
    http.post<AdminUser>(`/admin/users/${userId}/block`, { reason }).then((r) => r.data),
  unblock: (userId: string) => http.delete<AdminUser>(`/admin/users/${userId}/block`).then((r) => r.data),
  grant: (userId: string) => http.put<AdminUser>(`/admin/users/${userId}/superuser`).then((r) => r.data),
  revoke: (userId: string) => http.delete<AdminUser>(`/admin/users/${userId}/superuser`).then((r) => r.data),
  stars: (q: string) => http.get<AdminStar[]>("/admin/stars", { params: { q } }).then((r) => r.data),
  reports: (status: "open" | "all") =>
    http.get<AdminReport[]>("/admin/reports", { params: { status } }).then((r) => r.data),
  resolve: (reportId: string) => http.post(`/admin/reports/${reportId}/resolve`),
  tickets: (status: TicketFilter, kind?: TicketKind) =>
    http.get<AdminTicket[]>("/admin/tickets", { params: { status, kind } }).then((r) => r.data),
  /** Открыть обращение: сообщения автора становятся прочитанными. */
  ticket: (ticketId: string) => http.get<AdminTicketDetail>(`/admin/tickets/${ticketId}`).then((r) => r.data),
  replyTicket: (ticketId: string, text: string) =>
    http.post<AdminTicketDetail>(`/admin/tickets/${ticketId}/reply`, { text }).then((r) => r.data),
  setTicketStatus: (ticketId: string, status: TicketStatus) =>
    http.put<AdminTicketDetail>(`/admin/tickets/${ticketId}/status`, { status }).then((r) => r.data),
  /** Зашифрованная картинка обращения (ключ — в самом обращении). */
  ticketAttachment: (ticketId: string, attachmentId: string) =>
    http
      .get<ArrayBuffer>(`/admin/tickets/${ticketId}/attachments/${attachmentId}`, { responseType: "arraybuffer" })
      .then((r) => new Uint8Array(r.data)),
};

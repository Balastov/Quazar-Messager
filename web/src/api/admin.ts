import { http } from "./client";

/** «Чёрная дыра» — только для владельцев ресурса. Остальным все адреса отвечают 404. */
export interface AdminStats {
  users: number;
  online: number;
  blocked: number;
  stars: number;
  chats: number;
  messages_today: number;
  open_reports: number;
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
};

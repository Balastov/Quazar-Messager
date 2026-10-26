import { http } from "./client";
import type { User } from "./types";

export interface ManualStatusBody {
  kind: "meeting" | "dnd" | null;
  /** ISO; null — пока не сниму. */
  until: string | null;
}

export const usersApi = {
  /** «На встрече» / «Не беспокоить» с таймером; kind=null — снять. */
  setStatus: (body: ManualStatusBody) => http.put("/users/me/status", body).then((r) => r.data),
  me: () => http.get<User>("/users/me").then((r) => r.data),

  search: (q: string) =>
    http.get<User[]>("/users/search", { params: { q } }).then((r) => r.data),

  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.post<User>("/users/me/avatar", form).then((r) => r.data);
  },

  removeAvatar: () => http.delete<User>("/users/me/avatar").then((r) => r.data),

  /** Личный фон приложения; виден только самому пользователю. */
  background: () =>
    http.get<{ background_url: string | null }>("/users/me/background").then((r) => r.data),

  uploadBackground: (file: Blob) => {
    const form = new FormData();
    form.append("file", file, "background");
    return http
      .post<{ background_url: string | null }>("/users/me/background", form)
      .then((r) => r.data);
  },

  removeBackground: () =>
    http.delete<{ background_url: string | null }>("/users/me/background").then((r) => r.data),

  blocks: () => http.get<User[]>("/users/me/blocks").then((r) => r.data),
  block: (userId: string) => http.put(`/users/${userId}/block`),
  unblock: (userId: string) => http.delete(`/users/${userId}/block`),
  report: (userId: string, body: ReportBody) =>
    http.post<{ id: string }>(`/users/${userId}/report`, body).then((r) => r.data),
};

export type ReportReason = "spam" | "abuse" | "fraud" | "other";

export interface ReportBody {
  reason: ReportReason;
  comment?: string;
  chat_id?: string;
  /** Последние сообщения, расшифрованные здесь, — только с согласия. */
  evidence?: { sender: "me" | "them"; at: string; text: string }[];
  block?: boolean;
}

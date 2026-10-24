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
};

import { http } from "./client";
import type { User } from "./types";

export const usersApi = {
  me: () => http.get<User>("/users/me").then((r) => r.data),

  search: (q: string) =>
    http.get<User[]>("/users/search", { params: { q } }).then((r) => r.data),

  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.post<User>("/users/me/avatar", form).then((r) => r.data);
  },

  removeAvatar: () => http.delete<User>("/users/me/avatar").then((r) => r.data),
};

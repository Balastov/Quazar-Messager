import { http } from "./client";
import type { User } from "./types";

export const usersApi = {
  me: () => http.get<User>("/users/me").then((r) => r.data),

  search: (q: string) =>
    http.get<User[]>("/users/search", { params: { q } }).then((r) => r.data),
};

import { http } from "./client";
import type { TokenResponse } from "./types";

export interface RegisterBody {
  username: string;
  phone: string;
  password: string;
  /** Обязательный выбор: можно ли найти по номеру. */
  phone_discoverable: boolean;
  email?: string;
  first_name?: string;
  last_name?: string;
}

export const authApi = {
  register: (body: RegisterBody) =>
    http.post<TokenResponse>("/auth/register", body).then((r) => r.data),

  login: (phone: string, password: string) =>
    http.post<TokenResponse>("/auth/login", { phone, password }).then((r) => r.data),

  /** Свободен ли никнейм; reason — почему нельзя. */
  checkUsername: (username: string) =>
    http
      .get<{ available: boolean; reason: string | null }>("/auth/username-available", { params: { username } })
      .then((r) => r.data),
};

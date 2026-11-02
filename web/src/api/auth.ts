import { http } from "./client";
import type { TokenResponse } from "./types";

export interface RegisterBody {
  username: string;
  phone: string;
  /** Обязательный выбор: можно ли найти по номеру. */
  phone_discoverable: boolean;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone_verification_token?: string;
}

/** Данные из Яндекса для шага «Почти готово» (что не прошло наши правила — null). */
export interface YandexProfile {
  username: string | null;
  phone: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  has_avatar: boolean;
}

export type YandexExchange =
  | { status: "login"; access_token: string; profile: null }
  | { status: "register"; access_token: null; profile: YandexProfile };

export interface SignInMethods {
  has_password: boolean;
  phone_verified_at?: string | null;
  password_login_allowed?: boolean;
  identities: { provider: string; email: string | null; login: string | null; created_at: string }[];
  providers: { yandex: boolean };
}

export const authApi = {
  /** Какие внешние входы включены на сервере. */
  providers: () => http.get<{ yandex: boolean; phone_verification?: boolean }>("/auth/providers").then((r) => r.data),
  /** Адрес, с которого начинается вход через Яндекс (переход всей страницей). */
  yandexStartUrl: "/api/auth/yandex/start",
  yandexExchange: (code: string) =>
    http.post<YandexExchange>("/auth/yandex/exchange", { code }).then((r) => r.data),
  yandexComplete: (body: {
    code: string;
    username: string;
    phone: string;
    phone_discoverable: boolean;
    phone_verification_token?: string;
    first_name?: string | null;
    last_name?: string | null;
  }) => http.post<TokenResponse>("/auth/yandex/complete", body).then((r) => r.data),
  yandexLink: (proof: { phone_proof?: string; reauth_code?: string }) => http.post<{ url: string }>("/auth/yandex/link", proof).then((r) => r.data),
  /** Подтвердить себя через Яндекс (аккаунт без пароля перед тем, как задать пароль). */
  yandexReauth: () => http.post<{ url: string }>("/auth/yandex/reauth").then((r) => r.data),
  signInMethods: () => http.get<SignInMethods>("/users/me/sign-in").then((r) => r.data),
  unlink: (provider: string, proof: {password?: string; phone_proof?: string; reauth_code?: string}) => http.delete(`/users/me/identities/${provider}`, {data: proof}),
  phoneOptions: (phone: string) => http.post<{password_login_allowed: boolean}>("/auth/phone-login/options", {phone}).then(r => r.data),
  setPassword: (newPassword: string, opts: { currentPassword?: string; reauthCode?: string; confirmPassword?: string } = {}) =>
    http.put<TokenResponse>("/users/me/password", {
      new_password: newPassword,
      confirm_password: opts.confirmPassword ?? null,
      current_password: opts.currentPassword ?? null,
      reauth_code: opts.reauthCode ?? null,
    }).then((r) => r.data),
  forgotPassword: (login: string) => http.post<{ message: string }>("/auth/forgot-password", { login }).then((r) => r.data),

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

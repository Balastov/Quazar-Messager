import {http} from './client';
import type {TokenResponse} from './types';

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

/** Данные из Яндекса для шага «Почти готово» (что не прошло правила сервера — null). */
export interface YandexProfile {
  username: string | null;
  phone: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  has_avatar: boolean;
}

export type YandexExchange =
  | {status: 'login'; access_token: string; profile: null}
  | {status: 'register'; access_token: null; profile: YandexProfile};

export const authApi = {
  /** Какие внешние входы включены на сервере. */
  providers: () => http.get<{yandex: boolean}>('/auth/providers').then(r => r.data),

  yandexExchange: (code: string, verifier: string) =>
    http.post<YandexExchange>('/auth/yandex/exchange', {code, verifier}).then(r => r.data),

  yandexComplete: (body: {
    code: string;
    verifier: string;
    username: string;
    phone: string;
    phone_discoverable: boolean;
    first_name?: string | null;
    last_name?: string | null;
  }) => http.post<TokenResponse>('/auth/yandex/complete', body).then(r => r.data),

  register: (body: RegisterBody) =>
    http.post<TokenResponse>('/auth/register', body).then(r => r.data),

  login: (phone: string, password: string) =>
    http.post<TokenResponse>('/auth/login', {phone, password}).then(r => r.data),

  /** Свободен ли никнейм; reason — почему нельзя. */
  checkUsername: (username: string) =>
    http
      .get<{available: boolean; reason: string | null}>('/auth/username-available', {
        params: {username},
      })
      .then(r => r.data),
};

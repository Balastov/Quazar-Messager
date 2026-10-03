import {http} from './client';
import type {TokenResponse} from './types';

export const authApi = {
  register: (username: string, phone: string, password: string) =>
    http.post<TokenResponse>('/auth/register', {username, phone, password}).then(r => r.data),

  login: (phone: string, password: string) =>
    http.post<TokenResponse>('/auth/login', {phone, password}).then(r => r.data),
};

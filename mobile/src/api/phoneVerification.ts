import {http} from './client';

export interface PhoneVerification {
  state: 'pending' | 'verified' | 'expired' | 'failed';
  phone: string;
  call_phone: string | null;
  expires_at: string;
  verification_token: string | null;
  access_token?: string | null;
}
export type PhoneMode = boolean | 'login' | 'reauth';
function path(mode: PhoneMode) {
  return mode === 'login' ? '/auth/phone-login' : mode === 'reauth' ? '/users/me/phone-reauth' : mode ? '/users/me/phone-verification' : '/auth/phone-verification';
}
export const phoneVerificationApi = {
  start: (phone: string, account: PhoneMode = false) => http.post<PhoneVerification>(
    `${path(account)}/start`, account === true || account === 'reauth' ? {} : {phone},
  ).then(r => r.data),
  status: (token: string, account: PhoneMode = false) => http.post<PhoneVerification>(
    `${path(account)}/status`, {verification_token: token},
  ).then(r => r.data),
  completeLogin: (token: string) => http.post<{access_token: string}>('/auth/phone-login/complete', {verification_token: token}).then(r => r.data),
  reminder: () => http.post<{due: boolean; next_at: string; server_time: string}>('/users/me/phone-verification/reminder').then(r => r.data),
};

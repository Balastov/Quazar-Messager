import {http} from './client';

export interface PairView {
  id: string;
  kind: 'request' | 'invite' | 'keys';
  state: 'offered' | 'pending' | 'claimed' | 'approved' | 'consumed' | 'rejected' | 'expired';
  receiver_public_key: string | null;
  approver_public_key: string | null;
  account_public_key: string | null;
  account: {id: string; username: string; display_name: string; avatar_url: string | null} | null;
  device_name: string;
  created_at: string;
  expires_at: string;
  transferred_keys: boolean;
}
export interface EncryptedDeviceKeys {
  nonce: string;
  ciphertext: string;
}

const base = '/auth/device-pairing';

/** Перенос ключа переписки между своими устройствами, где уже выполнен вход. */
export const devicesApi = {
  requestKeys: (body: {public_key: string; receiver_secret: string; device_name: string}) =>
    http.post<{request: PairView; code: string}>(`${base}/key-requests`, body).then(r => r.data),
  status: (id: string, receiver_secret: string) =>
    http.post<PairView>(`${base}/requests/${id}/status`, {receiver_secret}).then(r => r.data),
  consumeKeys: (id: string, receiver_secret: string) =>
    http
      .post<{request: PairView; encrypted_keys: EncryptedDeviceKeys | null}>(`${base}/key-requests/${id}/consume`, {receiver_secret})
      .then(r => r.data),
  cancel: (id: string, receiver_secret: string) => http.post(`${base}/requests/${id}/cancel`, {receiver_secret}),
  claim: (body: {public_key: string; code: string}) => http.post<PairView>(`${base}/claim`, body).then(r => r.data),
  approve: (id: string, binding: string, encrypted_keys: EncryptedDeviceKeys) =>
    http
      .post<PairView>(`${base}/requests/${id}/approve`, {confirmed: true, binding, encrypted_keys, allow_without_keys: false})
      .then(r => r.data),
  reject: (id: string) => http.post(`${base}/owned/${id}/reject`),
};

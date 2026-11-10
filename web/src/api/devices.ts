import axios from "axios";
import { http } from "./client";

const anonymous = axios.create({ baseURL: "/api" });

export interface DeviceSession {
  id: string; name: string; current: boolean; created_at: string; last_seen_at: string; expires_at: string;
  /** Есть ли там ключ переписки аккаунта; null/нет поля — устройство не сообщало (старая версия). */
  has_account_key?: boolean | null;
}
export interface PairView {
  id: string; kind: "request" | "invite" | "keys"; state: "offered" | "pending" | "claimed" | "approved" | "consumed" | "rejected" | "expired";
  receiver_public_key: string | null; approver_public_key: string | null; account_public_key: string | null;
  account: { id: string; username: string; display_name: string; avatar_url: string | null } | null;
  device_name: string; created_at: string; expires_at: string; transferred_keys: boolean;
}
export interface EncryptedDeviceKeys { nonce: string; ciphertext: string }
export interface ReceiverRequest { public_key: string; receiver_secret: string; device_name: string }
export interface KeyConsumption { request: PairView; encrypted_keys: EncryptedDeviceKeys | null }
export interface PairConsumption { request: PairView; access_token: string; encrypted_keys: EncryptedDeviceKeys | null }

const base = "/auth/device-pairing";
export const devicesApi = {
  list: () => http.get<DeviceSession[]>("/auth/devices").then(r => r.data),
  revoke: (id: string) => http.delete(`/auth/devices/${id}`),
  /** Сообщить, какой ключ переписки сейчас на этом устройстве (публичный); null — ключа аккаунта нет. */
  reportKey: (public_key: string | null) => http.put("/auth/devices/current/key", { public_key }),
  revokeOthers: () => http.delete<{ access_token: string }>("/auth/devices/others").then(r => r.data),
  create: (body: ReceiverRequest) => anonymous.post<{ request: PairView; code: string }>(`${base}/requests`, body).then(r => r.data),
  /** Это устройство уже вошло, но без ключа переписки: просим его у другого своего устройства. */
  requestKeys: (body: ReceiverRequest) => http.post<{ request: PairView; code: string }>(`${base}/key-requests`, body).then(r => r.data),
  consumeKeys: (id: string, receiver_secret: string) => http.post<KeyConsumption>(`${base}/key-requests/${id}/consume`, { receiver_secret }).then(r => r.data),
  invite: (public_key: string) => http.post<{ request: PairView; invite_secret: string }>(`${base}/invitations`, { public_key }).then(r => r.data),
  accept: (id: string, body: ReceiverRequest & { invite_secret: string; expected_key: string }) => anonymous.post<PairView>(`${base}/invitations/${id}/accept`, body).then(r => r.data),
  claim: (body: { public_key: string; code?: string; request_id?: string; expected_key?: string }) => http.post<PairView>(`${base}/claim`, body).then(r => r.data),
  status: (id: string, receiver_secret: string) => anonymous.post<PairView>(`${base}/requests/${id}/status`, { receiver_secret }).then(r => r.data),
  owned: (id: string) => http.get<PairView>(`${base}/owned/${id}`).then(r => r.data),
  approve: (id: string, binding: string, encrypted_keys: EncryptedDeviceKeys | null, allow_without_keys: boolean) =>
    http.post<PairView>(`${base}/requests/${id}/approve`, { confirmed: true, binding, encrypted_keys, allow_without_keys }).then(r => r.data),
  consume: (id: string, receiver_secret: string) => anonymous.post<PairConsumption>(`${base}/requests/${id}/consume`, { receiver_secret }).then(r => r.data),
  cancel: (id: string, receiver_secret: string) => anonymous.post(`${base}/requests/${id}/cancel`, { receiver_secret }),
  reject: (id: string) => http.post(`${base}/owned/${id}/reject`),
  accountKey: (userId: string, token: string) => anonymous.get<{ public_key: string | null }>(`/users/${userId}/key`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.data.public_key),
  discard: (token: string) => anonymous.delete("/auth/devices/current", { headers: { Authorization: `Bearer ${token}` } }),
};

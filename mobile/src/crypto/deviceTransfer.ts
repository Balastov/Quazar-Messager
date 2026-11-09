/**
 * Перенос ключа переписки между своими устройствами — тот же протокол, что в web
 * (web/src/crypto/deviceTransfer.ts): одноразовые X25519-ключи устройств, nacl.box, код сравнения SHA-256.
 * Сервер видит только зашифрованный пакет.
 */
import {x25519} from '@noble/curves/ed25519';
import {sha256} from '@noble/hashes/sha2';
import {utf8ToBytes} from '@noble/hashes/utils';
import type {EncryptedDeviceKeys, PairView} from '../api/devices';
import {decodeB64, encodeB64} from './base64';
import {publicKeyFromSecret} from './identity';
import {box, boxKeyPair, boxOpen, bytesToUtf8, randomBytes, BOX_NONCE_BYTES} from './nacl';

export interface PairKeys {
  publicKey: string;
  secretKey: Uint8Array;
}
export interface TransferredKeys {
  seed: Uint8Array;
  archived: Uint8Array[];
}
const MAX_ARCHIVED = 256;

export function pairKeys(): PairKeys {
  const pair = boxKeyPair();
  return {publicKey: encodeB64(pair.publicKey), secretKey: pair.secretKey};
}

/** 32 случайных байта в base64url без «=» — 43 символа, как ждёт сервер. */
export function receiverSecret(): string {
  return encodeB64(randomBytes(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Ключ устройства: ровно 32 байта, каноничный base64 и не «слабая» точка кривой. */
export function devicePublicKey(value: string): Uint8Array {
  const raw = decodeB64(value);
  let weak = true;
  try {
    weak = x25519.getSharedSecret(randomBytes(32), raw).every(byte => byte === 0);
  } catch {
    weak = true;
  }
  if (raw.length !== 32 || encodeB64(raw) !== value || weak) {
    throw new Error('Некорректный ключ устройства');
  }
  return raw;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function pairBinding(flow: PairView): string {
  if (!flow.account || !flow.receiver_public_key || !flow.approver_public_key) {
    throw new Error('Подключение ещё не готово');
  }
  const data = ['quazar-device-v1', flow.id, flow.receiver_public_key, flow.approver_public_key,
    flow.account.id, flow.account_public_key || '', flow.device_name];
  return hex(sha256(utf8ToBytes(JSON.stringify(data))));
}

export function displayPairCode(binding: string): string {
  return binding.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ');
}

/** Собирает пакет для другого устройства. secret — текущий ключ аккаунта на этом телефоне. */
export function sealDeviceKeys(flow: PairView, keys: PairKeys, secret: Uint8Array): EncryptedDeviceKeys {
  if (flow.approver_public_key !== keys.publicKey || !flow.account || !flow.receiver_public_key) {
    throw new Error('Ключ подключения изменился. Начните заново');
  }
  const publicKey = publicKeyFromSecret(secret);
  if (!flow.account_public_key || publicKey !== flow.account_public_key) {
    throw new Error('На этом устройстве нет ключа текущей переписки');
  }
  const nonce = randomBytes(BOX_NONCE_BYTES);
  // Архив прежних ключей на телефоне не привязан к аккаунту — его не передаём.
  const plaintext = utf8ToBytes(JSON.stringify({version: 1, request_id: flow.id, user_id: flow.account.id,
    binding: pairBinding(flow), public_key: publicKey, seed: encodeB64(secret), archived: []}));
  try {
    return {
      nonce: encodeB64(nonce),
      ciphertext: encodeB64(box(plaintext, nonce, devicePublicKey(flow.receiver_public_key), keys.secretKey)),
    };
  } finally {
    plaintext.fill(0);
  }
}

export function openDeviceKeys(sealed: EncryptedDeviceKeys, flow: PairView, keys: PairKeys): TransferredKeys {
  if (flow.receiver_public_key !== keys.publicKey || !flow.approver_public_key || !flow.account || !flow.account_public_key) {
    throw new Error('Запрос подключения изменился');
  }
  const nonce = decodeB64(sealed.nonce);
  const ciphertext = decodeB64(sealed.ciphertext);
  if (nonce.length !== BOX_NONCE_BYTES || ciphertext.length > 75_000) {
    throw new Error('Некорректный пакет ключей');
  }
  const plaintext = boxOpen(ciphertext, nonce, devicePublicKey(flow.approver_public_key), keys.secretKey);
  if (!plaintext) {
    throw new Error('Не удалось проверить зашифрованные ключи. Начните заново');
  }
  try {
    const data = JSON.parse(bytesToUtf8(plaintext));
    if (data.version !== 1 || data.request_id !== flow.id || data.user_id !== flow.account.id ||
      data.binding !== pairBinding(flow) || data.public_key !== flow.account_public_key ||
      typeof data.seed !== 'string' || !Array.isArray(data.archived) || data.archived.length > MAX_ARCHIVED) {
      throw new Error('Пакет ключей относится к другому подключению');
    }
    const seed = decodeB64(data.seed);
    if (publicKeyFromSecret(seed) !== flow.account_public_key) {
      throw new Error('Ключ переписки не совпадает с ключом аккаунта');
    }
    const archived = data.archived.map((entry: {seed: string; public_key: string}) => {
      const value = decodeB64(entry.seed);
      if (publicKeyFromSecret(value) !== entry.public_key) {
        throw new Error('Повреждён архивный ключ');
      }
      return value;
    });
    return {seed, archived};
  } finally {
    plaintext.fill(0);
  }
}

/** Новые данные запроса не должны подменять уже сверенные ключи и аккаунт. */
export function checkPairUpdate(previous: PairView | null, next: PairView, keys: PairKeys, receiver: boolean): PairView {
  if ((receiver ? next.receiver_public_key : next.approver_public_key) !== keys.publicKey) {
    throw new Error('Ключ подключения изменился. Начните заново');
  }
  if (previous && (previous.id !== next.id || previous.kind !== next.kind)) {
    throw new Error('Запрос подключения изменился');
  }
  const pinned = (flow: PairView) => JSON.stringify([flow.receiver_public_key, flow.approver_public_key,
    flow.account?.id, flow.account_public_key, flow.device_name]);
  if (previous?.account && previous.approver_public_key && pinned(previous) !== pinned(next)) {
    throw new Error('Данные подключения изменились. Начните заново');
  }
  const rank: Record<PairView['state'], number> = {offered: 0, pending: 0, claimed: 1, approved: 2, consumed: 3, expired: 4, rejected: 4};
  return previous && rank[previous.state] > rank[next.state] ? previous : next;
}

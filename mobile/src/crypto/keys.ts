/**
 * Управление ключами E2E (mobile).
 *
 * У аккаунта один identity-ключ на все устройства (web и mobile). Новый ключ создаётся
 * только если у аккаунта его ещё нет; иначе ключ восстанавливается из резервной копии.
 *
 * Хранилище: AsyncStorage (MVP).
 * Продакшн: react-native-keychain (Keychain на iOS / Keystore на Android).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import {crypto_box_keypair, randombytes_buf, ready} from 'react-native-libsodium';
import {http} from '../api/client';
import {BackupError, decryptBackup, encryptBackup} from './backup';
import {decodeB64, encodeB64} from './base64';
import {publicKeyFromSecret} from './identity';

const KEY_PRIVATE = 'quazar_e2e_priv';
const KEY_PUBLIC = 'quazar_e2e_pub';
/** Прежние ключи — только для чтения старой истории. */
const KEY_LEGACY = 'quazar_e2e_legacy';

/** Копия расшифрована, но в ней не тот ключ, что сейчас у аккаунта на сервере. */
export class StaleBackupError extends BackupError {
  constructor(
    readonly backupPublicKey: string,
    readonly accountPublicKey: string,
  ) {
    super(
      'В резервной копии другой ключ, чем сейчас у аккаунта: ключ на сервере сменили с другого устройства.',
    );
    this.name = 'StaleBackupError';
  }
}

/** Короткий идентификатор ключа для сверки глазами. */
export function shortKeyId(publicKey: string | null | undefined): string {
  if (!publicKey) {return '—';}
  const clean = publicKey.replace(/=+$/, '');
  return `${clean.slice(0, 4)}…${clean.slice(-4)}`;
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

let _identity: KeyPair | null | undefined;

async function readIdentity(): Promise<KeyPair | null> {
  if (_identity !== undefined) {
    return _identity;
  }
  const [[, pub], [, priv]] = await AsyncStorage.multiGet([KEY_PUBLIC, KEY_PRIVATE]);
  if (!pub || !priv) {
    _identity = null;
    return null;
  }
  // Пересчитываем публичный ключ: старые версии хранили URL-safe base64.
  const secret = decodeB64(priv);
  _identity = {publicKey: publicKeyFromSecret(secret), privateKey: encodeB64(secret)};
  return _identity;
}

async function readLegacy(): Promise<KeyPair[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_LEGACY);
    return raw ? (JSON.parse(raw) as KeyPair[]) : [];
  } catch {
    return [];
  }
}

/** Делает секретный ключ текущим; прежний (если другой) уходит в архив. */
async function saveIdentity(secret: Uint8Array): Promise<KeyPair> {
  const next: KeyPair = {publicKey: publicKeyFromSecret(secret), privateKey: encodeB64(secret)};
  const current = await readIdentity();
  const legacy = await readLegacy();
  if (
    current &&
    current.publicKey !== next.publicKey &&
    !legacy.some(k => k.publicKey === current.publicKey)
  ) {
    legacy.push(current);
  }
  await AsyncStorage.multiSet([
    [KEY_PUBLIC, next.publicKey],
    [KEY_PRIVATE, next.privateKey],
    [KEY_LEGACY, JSON.stringify(legacy)],
  ]);
  _identity = next;
  return next;
}

async function generateIdentity(): Promise<KeyPair> {
  await ready;
  return saveIdentity(crypto_box_keypair().privateKey);
}

/** Текущий ключ устройства (без создания нового). */
export function loadKeys(): Promise<KeyPair | null> {
  return readIdentity();
}

/** Приватные ключи для расшифровки: текущий + архив. */
export async function loadDecryptionKeys(): Promise<string[]> {
  const current = await readIdentity();
  const legacy = await readLegacy();
  return [...(current ? [current.privateKey] : []), ...legacy.map(k => k.privateKey)];
}

async function uploadPublicKey(publicKey: string): Promise<void> {
  await http.put('/users/me/key', {public_key: publicKey});
}

/** Ключ аккаунта на сервере, без кэша. Ошибки сети пробрасываются. */
async function fetchAccountPublicKey(userId: string): Promise<string | null> {
  const {data} = await http.get<{public_key: string | null}>(`/users/${userId}/key`);
  return data.public_key;
}

export async function fetchKeyBackup(): Promise<string | null> {
  try {
    const {data} = await http.get<{backup: string | null}>('/users/me/key-backup');
    return data.backup;
  } catch {
    return null;
  }
}

export type IdentitySyncResult =
  | {status: 'ready'; publicKey: string; hasServerBackup: boolean}
  | {
      status: 'needs_restore';
      hasLocalKey: boolean;
      hasServerBackup: boolean;
      accountPublicKey: string | null;
      localPublicKey: string | null;
    };

/**
 * Сверяет ключ устройства с ключом аккаунта.
 * Новый ключ создаётся, только если у аккаунта ключа ещё нет.
 */
export async function syncIdentityWithServer(userId: string): Promise<IdentitySyncResult> {
  const serverKey = await fetchAccountPublicKey(userId);
  const local = await readIdentity();

  if (serverKey) {
    const hasServerBackup = (await fetchKeyBackup()) !== null;
    if (local?.publicKey === serverKey) {
      return {status: 'ready', publicKey: serverKey, hasServerBackup};
    }
    return {
      status: 'needs_restore',
      hasLocalKey: local !== null,
      hasServerBackup,
      accountPublicKey: serverKey,
      localPublicKey: local?.publicKey ?? null,
    };
  }

  // У аккаунта ещё нет ключа: создаём новый (локальный мог остаться от другого аккаунта
  // на этом устройстве — он уйдёт в архив).
  const keys = await generateIdentity();
  try {
    await uploadPublicKey(keys.publicKey);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      // Другое устройство успело зарегистрировать свой ключ раньше.
      return {
        status: 'needs_restore',
        hasLocalKey: true,
        hasServerBackup: (await fetchKeyBackup()) !== null,
        accountPublicKey: await fetchAccountPublicKey(userId),
        localPublicKey: keys.publicKey,
      };
    }
    throw err;
  }
  invalidateKeyCache(userId);
  return {status: 'ready', publicKey: keys.publicKey, hasServerBackup: false};
}

/** Восстанавливает ключ аккаунта из резервной копии на сервере. */
export async function restoreFromServerBackup(userId: string, password: string): Promise<void> {
  const blob = await fetchKeyBackup();
  if (!blob) {
    throw new BackupError('На сервере нет резервной копии');
  }
  const {publicKey, secret} = await decryptBackup(blob, password);
  const serverKey = await fetchAccountPublicKey(userId);
  if (serverKey && serverKey !== publicKey) {
    throw new StaleBackupError(publicKey, serverKey);
  }

  await saveIdentity(secret);
  if (!serverKey) {
    await uploadPublicKey(publicKey);
  }
  invalidateKeyCache(userId);
}

/**
 * Делает ключ из резервной копии на сервере ключом аккаунта (подтверждение паролем аккаунта).
 * Нужен, когда ключ на сервере перезаписало другое устройство, а копия — с «правильным» ключом.
 */
export async function adoptServerBackupAsAccountKey(
  userId: string,
  backupPassword: string,
  accountPassword: string,
): Promise<void> {
  const blob = await fetchKeyBackup();
  if (!blob) {
    throw new BackupError('На сервере нет резервной копии');
  }
  const {publicKey, secret} = await decryptBackup(blob, backupPassword);
  await http.post('/users/me/key/rotate', {
    password: accountPassword,
    public_key: publicKey,
  });
  await saveIdentity(secret);
  // Ротация удаляет копию на сервере; эта копия как раз для нового ключа аккаунта.
  await http.put('/users/me/key-backup', {backup: blob});
  invalidateKeyCache(userId);
}

/** Создаёт копию и сохраняет её на сервере. Только для актуального ключа аккаунта. */
export async function createAndUploadBackup(userId: string, password: string): Promise<void> {
  const local = await readIdentity();
  const serverKey = await fetchAccountPublicKey(userId);
  if (!local || local.publicKey !== serverKey) {
    throw new BackupError(
      'Ключ этого устройства не совпадает с ключом аккаунта. Сначала восстановите ключи из резервной копии.',
    );
  }
  const blob = await encryptBackup(decodeB64(local.privateKey), password);
  await http.put('/users/me/key-backup', {backup: blob});
}

/**
 * Новая пара ключей для аккаунта. Локально сохраняется только после того,
 * как сервер принял ключ (иначе при неверном пароле устройство осталось бы без ключа аккаунта).
 */
export async function rotateKeys(userId: string, accountPassword: string): Promise<void> {
  await ready;
  const secret = randombytes_buf(32);
  await http.post('/users/me/key/rotate', {
    password: accountPassword,
    public_key: publicKeyFromSecret(secret),
  });
  await saveIdentity(secret);
  invalidateKeyCache(userId);
}

const _keyCache = new Map<string, string>();

export function invalidateKeyCache(userId?: string): void {
  if (userId) {
    _keyCache.delete(userId);
  } else {
    _keyCache.clear();
  }
}

export async function fetchUserPublicKey(userId: string): Promise<string | null> {
  if (_keyCache.has(userId)) {return _keyCache.get(userId)!;}
  try {
    const {data} = await http.get<{user_id: string; public_key: string | null}>(
      `/users/${userId}/key`,
    );
    if (data.public_key) {
      _keyCache.set(userId, data.public_key);
      return data.public_key;
    }
    return null;
  } catch {
    return null;
  }
}

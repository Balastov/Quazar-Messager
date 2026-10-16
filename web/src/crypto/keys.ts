/**
 * Управление E2E ключами (web).
 *
 * У аккаунта один identity-ключ на все устройства. Создаётся он только на первом
 * устройстве; остальные получают его из зашифрованной паролем резервной копии.
 * Устройство никогда не перезаписывает ключ на сервере молча — только явная ротация.
 */
import axios from "axios";
import nacl from "tweetnacl";
import { http } from "../api/client";
import { BackupError, createBackupBlob, decryptBackup } from "./backup";
import {
  derivePublicKeyFromSeed,
  generateIdentityKeyPair,
  loadIdentityKeyPair,
  loadLegacyIdentities,
  saveIdentitySeed,
  type LocalIdentity,
} from "./webcrypto";

export { encodeBase64, decodeBase64 } from "tweetnacl-util";

const LEGACY_KEY_PRIVATE = "quazar_e2e_priv";
const LEGACY_KEY_PUBLIC = "quazar_e2e_pub";
const MIGRATION_UI_KEY = "quazar_e2e_migration_ui";
const BACKUP_DONE_KEY = "quazar_e2e_backup_done";

export type IdentityKeys = LocalIdentity;

export type DecryptionKey = Pick<LocalIdentity, "seed" | "privateKey">;

/** Удаляет legacy-ключи из localStorage (tweetnacl MVP). */
export function migrateLegacyKeys(): boolean {
  const hadLegacy =
    localStorage.getItem(LEGACY_KEY_PRIVATE) !== null ||
    localStorage.getItem(LEGACY_KEY_PUBLIC) !== null;

  if (hadLegacy) {
    localStorage.removeItem(LEGACY_KEY_PRIVATE);
    localStorage.removeItem(LEGACY_KEY_PUBLIC);
    localStorage.setItem(MIGRATION_UI_KEY, "1");
  }

  return hadLegacy;
}

export function consumeMigrationUiFlag(): boolean {
  if (localStorage.getItem(MIGRATION_UI_KEY) !== "1") return false;
  localStorage.removeItem(MIGRATION_UI_KEY);
  return true;
}

export function markBackupDone(): void {
  localStorage.setItem(BACKUP_DONE_KEY, "1");
}

export function hasBackupDone(): boolean {
  return localStorage.getItem(BACKUP_DONE_KEY) === "1";
}

function clearBackupDone(): void {
  localStorage.removeItem(BACKUP_DONE_KEY);
}

/** Текущий ключ устройства (без создания нового). */
export function loadKeys(): Promise<IdentityKeys | null> {
  return loadIdentityKeyPair();
}

/** Текущий ключ + архив прежних — для расшифровки истории. */
export async function loadDecryptionKeys(): Promise<DecryptionKey[]> {
  const current = await loadIdentityKeyPair();
  const legacy = await loadLegacyIdentities();
  return [...(current ? [current] : []), ...legacy];
}

export async function uploadPublicKey(publicKey: string): Promise<void> {
  await http.put("/users/me/key", { public_key: publicKey });
}

/** Ключ аккаунта на сервере, без кэша. Ошибки сети пробрасываются. */
async function fetchAccountPublicKey(userId: string): Promise<string | null> {
  const { data } = await http.get<{ public_key: string | null }>(`/users/${userId}/key`);
  return data.public_key;
}

export async function uploadKeyBackup(blob: string): Promise<void> {
  await http.put("/users/me/key-backup", { backup: blob });
}

export async function fetchKeyBackup(): Promise<string | null> {
  try {
    const { data } = await http.get<{ backup: string | null }>("/users/me/key-backup");
    return data.backup;
  } catch {
    return null;
  }
}

export type IdentitySyncResult =
  | { status: "ready"; publicKey: string; hasServerBackup: boolean }
  | { status: "needs_restore"; hasLocalKey: boolean; hasServerBackup: boolean };

/**
 * Сверяет ключ устройства с ключом аккаунта.
 * Новый ключ создаётся, только если у аккаунта ключа ещё нет.
 */
export async function syncIdentityWithServer(userId: string): Promise<IdentitySyncResult> {
  migrateLegacyKeys();

  const serverKey = await fetchAccountPublicKey(userId);
  const local = await loadIdentityKeyPair();

  if (serverKey) {
    const hasServerBackup = (await fetchKeyBackup()) !== null;
    if (local?.publicKey === serverKey) {
      return { status: "ready", publicKey: serverKey, hasServerBackup };
    }
    return { status: "needs_restore", hasLocalKey: local !== null, hasServerBackup };
  }

  // У аккаунта ещё нет ключа: создаём новый (локальный мог остаться от другого аккаунта
  // в этом браузере — он уйдёт в архив).
  const { publicKey } = await generateIdentityKeyPair();
  try {
    await uploadPublicKey(publicKey);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      // Другое устройство успело зарегистрировать свой ключ раньше.
      return {
        status: "needs_restore",
        hasLocalKey: true,
        hasServerBackup: (await fetchKeyBackup()) !== null,
      };
    }
    throw err;
  }
  invalidateKeyCache(userId);
  return { status: "ready", publicKey, hasServerBackup: false };
}

/** Восстанавливает ключ аккаунта из резервной копии на этом устройстве. */
export async function restoreFromBackup(
  userId: string,
  blob: string,
  password: string
): Promise<string> {
  const { publicKey, seed } = await decryptBackup(blob, password);
  const serverKey = await fetchAccountPublicKey(userId);
  if (serverKey && serverKey !== publicKey) {
    throw new BackupError(
      "Резервная копия устарела: ключ аккаунта с тех пор сменился. Создайте новую копию на устройстве, где сообщения читаются."
    );
  }

  await saveIdentitySeed(seed);
  if (!serverKey) {
    await uploadPublicKey(publicKey);
  }
  invalidateKeyCache(userId);
  markBackupDone();
  return publicKey;
}

/** Создаёт копию и сохраняет её на сервере. Только для актуального ключа аккаунта. */
export async function createAndUploadBackup(userId: string, password: string): Promise<string> {
  const local = await loadIdentityKeyPair();
  const serverKey = await fetchAccountPublicKey(userId);
  if (!local || local.publicKey !== serverKey) {
    throw new BackupError(
      "Ключ этого устройства не совпадает с ключом аккаунта. Сначала восстановите ключи из резервной копии."
    );
  }

  const blob = await createBackupBlob(password);
  await uploadKeyBackup(blob);
  markBackupDone();
  return blob;
}

/**
 * Новая пара ключей для аккаунта. Локально сохраняется только после того,
 * как сервер принял ключ (иначе при неверном пароле устройство осталось бы без ключа аккаунта).
 */
export async function rotateKeys(userId: string, accountPassword: string): Promise<string> {
  const seed = nacl.randomBytes(32);
  const publicKey = derivePublicKeyFromSeed(seed);
  await http.post("/users/me/key/rotate", {
    password: accountPassword,
    public_key: publicKey,
  });
  await saveIdentitySeed(seed);
  invalidateKeyCache(userId);
  clearBackupDone();
  return publicKey;
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
  if (_keyCache.has(userId)) return _keyCache.get(userId)!;
  try {
    const { data } = await http.get<{ user_id: string; public_key: string | null }>(
      `/users/${userId}/key`
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

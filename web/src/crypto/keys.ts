/**
 * Управление E2E ключами (web).
 * Приватный ключ — non-exportable CryptoKey в IndexedDB.
 * Публичный ключ — base64 в IndexedDB (рядом с приватным).
 */
import { http } from "../api/client";
import {
  generateIdentityKeyPair,
  loadIdentityKeyPair,
} from "./webcrypto";

export { encodeBase64, decodeBase64 } from "tweetnacl-util";

const LEGACY_KEY_PRIVATE = "quazar_e2e_priv";
const LEGACY_KEY_PUBLIC = "quazar_e2e_pub";
const MIGRATION_UI_KEY = "quazar_e2e_migration_ui";

export interface IdentityKeys {
  publicKey: string;
  privateKey: CryptoKey;
}

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

export function markMigrationForUi(): void {
  localStorage.setItem(MIGRATION_UI_KEY, "1");
}

export function consumeMigrationUiFlag(): boolean {
  if (localStorage.getItem(MIGRATION_UI_KEY) !== "1") return false;
  localStorage.removeItem(MIGRATION_UI_KEY);
  return true;
}

export async function loadOrCreateKeys(): Promise<IdentityKeys & { migrated: boolean }> {
  const migrated = migrateLegacyKeys();

  const existing = await loadIdentityKeyPair();
  if (existing) {
    return { ...existing, migrated };
  }

  const created = await generateIdentityKeyPair();
  return { ...created, migrated: migrated || true };
}

export async function uploadPublicKey(
  publicKey: string,
  force = false
): Promise<void> {
  await http.put("/users/me/key", { public_key: publicKey, force });
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

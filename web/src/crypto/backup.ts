/**
 * Encrypted E2E key backup.
 * Format: ENC_BACKUP:v1: + base64( salt[16] || iv[12] || ciphertext )
 * Ciphertext = AES-GCM( JSON { version, publicKey, seed } ), key = PBKDF2(password)
 */
import { encodeBase64, decodeBase64 } from "tweetnacl-util";
import { getIdentitySeed, loadIdentityKeyPair, restoreIdentityFromSeed } from "./webcrypto";

export const BACKUP_PREFIX = "ENC_BACKUP:v1:";
const PBKDF2_ITERATIONS = 210_000;
const SALT_LEN = 16;
const IV_LEN = 12;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

interface BackupPayload {
  version: 1;
  publicKey: string;
  seed: string; // base64
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createBackupBlob(password: string): Promise<string> {
  if (password.length < 8) {
    throw new BackupError("Пароль для резервной копии должен быть не короче 8 символов");
  }

  const identity = await loadIdentityKeyPair();
  const seed = await getIdentitySeed();
  if (!identity || !seed) {
    throw new BackupError(
      "Резервная копия недоступна для текущих ключей. Сначала выполните ротацию ключей."
    );
  }

  const payload: BackupPayload = {
    version: 1,
    publicKey: identity.publicKey,
    seed: encodeBase64(seed),
  };

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const aesKey = await deriveAesKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext)
  );

  const blob = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.length);
  blob.set(salt, 0);
  blob.set(iv, SALT_LEN);
  blob.set(ciphertext, SALT_LEN + IV_LEN);

  return BACKUP_PREFIX + encodeBase64(blob);
}

export async function restoreFromBackupBlob(
  backup: string,
  password: string
): Promise<{ publicKey: string }> {
  if (!backup.startsWith(BACKUP_PREFIX)) {
    throw new BackupError("Неверный формат резервной копии");
  }

  try {
    const raw = decodeBase64(backup.slice(BACKUP_PREFIX.length));
    if (raw.length < SALT_LEN + IV_LEN + 16) {
      throw new BackupError("Повреждённая резервная копия");
    }

    const salt = raw.slice(0, SALT_LEN);
    const iv = raw.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const ciphertext = raw.slice(SALT_LEN + IV_LEN);
    const aesKey = await deriveAesKey(password, salt);

    const plainBytes = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext)
    );
    const parsed = JSON.parse(new TextDecoder().decode(plainBytes)) as BackupPayload;

    if (parsed.version !== 1 || !parsed.seed || !parsed.publicKey) {
      throw new BackupError("Неподдерживаемая версия резервной копии");
    }

    const restored = await restoreIdentityFromSeed(parsed.seed);
    if (restored.publicKey !== parsed.publicKey) {
      throw new BackupError("Ключи в резервной копии повреждены");
    }
    return { publicKey: restored.publicKey };
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError("Не удалось расшифровать. Проверьте пароль и файл.");
  }
}

export function downloadBackupFile(blob: string, username: string): void {
  const filename = `quazar-keys-${username || "backup"}.quazar-key`;
  const file = new Blob([blob], { type: "application/octet-stream" });
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function readBackupFile(file: File): Promise<string> {
  const text = (await file.text()).trim();
  if (!text.startsWith(BACKUP_PREFIX)) {
    throw new BackupError("Файл не является резервной копией Quazar");
  }
  return text;
}

/**
 * Зашифрованная резервная копия E2E-ключа — тот же формат, что в web/src/crypto/backup.ts:
 * ENC_BACKUP:v1: + base64( salt[16] || iv[12] || AES-256-GCM(JSON { version, publicKey, seed }) )
 * Ключ AES = PBKDF2-SHA256(password, salt, 210 000 итераций).
 *
 * В React Native нет WebCrypto, поэтому PBKDF2 и AES-GCM — из @noble (чистый JS).
 */
import {gcm} from '@noble/ciphers/aes';
import {pbkdf2Async} from '@noble/hashes/pbkdf2';
import {sha256} from '@noble/hashes/sha2';
import {utf8ToBytes} from '@noble/hashes/utils';
import {randombytes_buf, ready, to_string} from 'react-native-libsodium';
import {decodeB64, encodeB64} from './base64';
import {publicKeyFromSecret} from './identity';

export const BACKUP_PREFIX = 'ENC_BACKUP:v1:';
const PBKDF2_ITERATIONS = 210_000;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

interface BackupPayload {
  version: 1;
  publicKey: string;
  seed: string; // base64
}

function deriveAesKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  // asyncTick отдаёт управление UI-потоку: на Hermes это несколько секунд вычислений.
  return pbkdf2Async(sha256, utf8ToBytes(password), salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: 32,
    asyncTick: 20,
  });
}

export async function encryptBackup(secret: Uint8Array, password: string): Promise<string> {
  if (password.length < 8) {
    throw new BackupError('Пароль для резервной копии должен быть не короче 8 символов');
  }
  await ready;

  const payload: BackupPayload = {
    version: 1,
    publicKey: publicKeyFromSecret(secret),
    seed: encodeB64(secret),
  };

  const salt = randombytes_buf(SALT_LEN);
  const iv = randombytes_buf(IV_LEN);
  const aesKey = await deriveAesKey(password, salt);
  const ciphertext = gcm(aesKey, iv).encrypt(utf8ToBytes(JSON.stringify(payload)));

  const blob = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.length);
  blob.set(salt, 0);
  blob.set(iv, SALT_LEN);
  blob.set(ciphertext, SALT_LEN + IV_LEN);
  return BACKUP_PREFIX + encodeB64(blob);
}

export async function decryptBackup(
  backup: string,
  password: string,
): Promise<{publicKey: string; secret: Uint8Array}> {
  if (!backup.startsWith(BACKUP_PREFIX)) {
    throw new BackupError('Неверный формат резервной копии');
  }

  try {
    await ready;
    const raw = decodeB64(backup.slice(BACKUP_PREFIX.length));
    if (raw.length < SALT_LEN + IV_LEN + TAG_LEN) {
      throw new BackupError('Повреждённая резервная копия');
    }

    const salt = raw.slice(0, SALT_LEN);
    const iv = raw.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const ciphertext = raw.slice(SALT_LEN + IV_LEN);
    const aesKey = await deriveAesKey(password, salt);
    const plainBytes = gcm(aesKey, iv).decrypt(ciphertext);
    const parsed = JSON.parse(to_string(plainBytes)) as BackupPayload;

    if (parsed.version !== 1 || !parsed.seed || !parsed.publicKey) {
      throw new BackupError('Неподдерживаемая версия резервной копии');
    }

    const secret = decodeB64(parsed.seed);
    if (secret.length !== 32 || publicKeyFromSecret(secret) !== parsed.publicKey) {
      throw new BackupError('Ключи в резервной копии повреждены');
    }
    return {publicKey: parsed.publicKey, secret};
  } catch (err) {
    if (err instanceof BackupError) {
      throw err;
    }
    throw new BackupError('Не удалось расшифровать. Проверьте пароль резервной копии.');
  }
}

/**
 * Картинка в сообщении — «IMG1:{json}» (как в web/src/attachments/image.ts).
 * Файл шифруется случайным ключом (NaCl secretbox): nonce[24] || mac[16] || ciphertext.
 * @noble/ciphers xsalsa20poly1305 побайтово совместим с tweetnacl secretbox из web.
 */
import {xsalsa20poly1305} from '@noble/ciphers/salsa';
import {randombytes_buf, ready} from 'react-native-libsodium';
import {decodeB64, encodeB64} from '../crypto/base64';

export const IMAGE_PREFIX = 'IMG1:';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageRef {
  /** id вложения на сервере. */
  id: string;
  /** base64 ключа secretbox (32 байта). */
  key: string;
  mime: ImageMime;
  w: number;
  h: number;
  size: number;
}

const MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

/** Тип картинки по сигнатуре; видео, SVG и прочее — null. */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) {
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...Array.from(bytes.subarray(from, to)));
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    return 'image/gif';
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Картинка из галереи (base64 от image picker) → байты; бросает Error с текстом для пользователя. */
export async function readPickedImage(base64: string): Promise<{bytes: Uint8Array; mime: ImageMime}> {
  await ready;
  const bytes = decodeB64(base64);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Картинка больше 10 МБ — такую не отправить');
  }
  const mime = detectImageMime(bytes);
  if (!mime) {
    throw new Error('Можно отправлять только картинки: JPEG, PNG, GIF или WebP');
  }
  return {bytes, mime};
}

export function encodeImage(ref: ImageRef): string {
  return IMAGE_PREFIX + JSON.stringify(ref);
}

export function parseImage(payload: string): ImageRef | null {
  if (!payload.startsWith(IMAGE_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(payload.slice(IMAGE_PREFIX.length));
    if (
      typeof raw?.id !== 'string' || !ID_RE.test(raw.id) ||
      typeof raw.key !== 'string' ||
      !MIMES.includes(raw.mime) ||
      !Number.isFinite(raw.w) || !Number.isFinite(raw.h) || raw.w <= 0 || raw.h <= 0 ||
      !Number.isFinite(raw.size)
    ) {
      return null;
    }
    return {id: raw.id, key: raw.key, mime: raw.mime, w: raw.w, h: raw.h, size: raw.size};
  } catch {
    return null;
  }
}

export async function encryptFile(data: Uint8Array): Promise<{blob: Uint8Array; key: string}> {
  await ready;
  const key = randombytes_buf(KEY_BYTES);
  const nonce = randombytes_buf(NONCE_BYTES);
  const box = xsalsa20poly1305(key, nonce).encrypt(data);
  const blob = new Uint8Array(NONCE_BYTES + box.length);
  blob.set(nonce, 0);
  blob.set(box, NONCE_BYTES);
  return {blob, key: encodeB64(key)};
}

export async function decryptFile(blob: Uint8Array, keyB64: string): Promise<Uint8Array | null> {
  await ready;
  try {
    const key = decodeB64(keyB64);
    if (key.length !== KEY_BYTES || blob.length <= NONCE_BYTES) {
      return null;
    }
    return xsalsa20poly1305(key, blob.subarray(0, NONCE_BYTES)).decrypt(
      blob.subarray(NONCE_BYTES),
    );
  } catch {
    return null;
  }
}

/** Размер под картинку: вписываем в box, не увеличивая. */
export function fitSize(
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): {width: number; height: number} {
  const scale = Math.min(1, maxW / w, maxH / h);
  return {width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale))};
}

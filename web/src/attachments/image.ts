/**
 * Картинка в сообщении — текст «IMG1:{json}» со ссылкой на вложение и ключом к нему.
 * Файл шифруется случайным ключом (NaCl secretbox): nonce[24] || mac[16] || ciphertext.
 * В личных чатах сам текст шифруется E2E, поэтому сервер не видит ни картинку, ни ключ.
 */
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";

export const IMAGE_PREFIX = "IMG1:";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Ошибка с текстом для пользователя: слишком большой файл, не картинка и т.п. */
export class AttachmentError extends Error {}

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

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

const MIMES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Тип картинки по сигнатуре; видео, SVG и прочее — null. */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export function encodeImage(ref: ImageRef): string {
  return IMAGE_PREFIX + JSON.stringify(ref);
}

export function parseImage(payload: string): ImageRef | null {
  if (!payload.startsWith(IMAGE_PREFIX)) return null;
  try {
    const raw = JSON.parse(payload.slice(IMAGE_PREFIX.length));
    if (
      typeof raw?.id !== "string" || !ID_RE.test(raw.id) ||
      typeof raw.key !== "string" ||
      !MIMES.includes(raw.mime) ||
      !Number.isFinite(raw.w) || !Number.isFinite(raw.h) || raw.w <= 0 || raw.h <= 0 ||
      !Number.isFinite(raw.size)
    ) {
      return null;
    }
    return { id: raw.id, key: raw.key, mime: raw.mime, w: raw.w, h: raw.h, size: raw.size };
  } catch {
    return null;
  }
}

export function encryptFile(data: Uint8Array): { blob: Uint8Array; key: string } {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(data, nonce, key);
  const blob = new Uint8Array(nonce.length + box.length);
  blob.set(nonce, 0);
  blob.set(box, nonce.length);
  return { blob, key: encodeBase64(key) };
}

export function decryptFile(blob: Uint8Array, keyB64: string): Uint8Array | null {
  try {
    const key = decodeBase64(keyB64);
    if (key.length !== nacl.secretbox.keyLength) return null;
    const n = nacl.secretbox.nonceLength;
    if (blob.length <= n) return null;
    return nacl.secretbox.open(blob.subarray(n), blob.subarray(0, n), key);
  } catch {
    return null;
  }
}

/** Байты картинки как Blob. Наши буферы — всегда обычный ArrayBuffer, не Shared. */
export function imageBlob(bytes: Uint8Array, mime: string): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
}

/** Размер пузыря под картинку: вписываем в box, не увеличивая. */
export function fitSize(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export const IMAGE_PREVIEW = "📷 Фото";

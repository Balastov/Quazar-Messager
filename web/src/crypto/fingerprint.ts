/**
 * Код безопасности (safety number) для сверки E2E-ключей.
 *
 * Один и тот же у обоих собеседников: SHA-256 от отсортированной пары публичных ключей,
 * ещё раз SHA-256 от результата — 64 байта; из них 12 групп по 5 байт → 12 чисел по 5 цифр
 * (как в Signal: каждая группа — 40 бит по модулю 100 000). Все 60 цифр независимы.
 *
 * Тот же код зашит в QR («QZV1:» + 60 цифр): собеседник сканирует его камерой и сверяет
 * со своим, вместо того чтобы читать цифры вслух.
 */
import { decodeBase64 } from "tweetnacl-util";

export const QR_PREFIX = "QZV1:";
const GROUPS = 12;

function digitsFrom(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 256 + bytes[g * 5 + i];
    groups.push(String(value % 100_000).padStart(5, "0"));
  }
  return groups.join(" ");
}

export async function computeFingerprint(
  myPublicKeyB64: string,
  theirPublicKeyB64: string
): Promise<string> {
  const sorted = [myPublicKeyB64, theirPublicKeyB64].sort();
  const a = decodeBase64(sorted[0]);
  const b = decodeBase64(sorted[1]);
  const payload = new Uint8Array(a.length + b.length);
  payload.set(a, 0);
  payload.set(b, a.length);

  const first = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  const second = new Uint8Array(await crypto.subtle.digest("SHA-256", first));
  const bytes = new Uint8Array(64);
  bytes.set(first, 0);
  bytes.set(second, 32);
  return digitsFrom(bytes);
}

export function fingerprintMatches(a: string, b: string): boolean {
  return a.replace(/\s/g, "") === b.replace(/\s/g, "");
}

/** Текст QR-кода для сверки. */
export function fingerprintQr(fingerprint: string): string {
  return QR_PREFIX + fingerprint.replace(/\s/g, "");
}

/** Код безопасности из отсканированного QR; чужой QR — null. */
export function parseFingerprintQr(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith(QR_PREFIX)) return null;
  const digits = t.slice(QR_PREFIX.length);
  return /^\d{60}$/.test(digits) ? digits : null;
}

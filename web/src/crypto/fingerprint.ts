/**
 * Safety number (fingerprint) для сверки E2E-ключей.
 * SHA-256 от отсортированной пары публичных ключей → 60 цифр.
 */
import { decodeBase64 } from "tweetnacl-util";

function bytesToDigits(bytes: Uint8Array, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(String(bytes[i % bytes.length] % 10));
  }
  const digits = parts.join("");
  return digits.match(/.{1,5}/g)?.join(" ") ?? digits;
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

  const hash = await crypto.subtle.digest("SHA-256", payload);
  return bytesToDigits(new Uint8Array(hash), 60);
}

export function fingerprintMatches(a: string, b: string): boolean {
  return a.replace(/\s/g, "") === b.replace(/\s/g, "");
}

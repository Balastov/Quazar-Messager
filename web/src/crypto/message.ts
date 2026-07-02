/**
 * E2E шифрование сообщений (web).
 * Схема: X25519 + XSalsa20-Poly1305 (NaCl crypto_box via tweetnacl)
 *
 * Формат: "ENC1:" + base64( eph_pub[32] || nonce[24] || ciphertext[n+16] )
 */
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from "tweetnacl-util";
import { deriveBoxSharedKey } from "./webcrypto";

export const E2E_PREFIX = "ENC1:";

export function encryptMessage(plaintext: string, recipientPublicKeyB64: string): string {
  const recipientPubKey = decodeBase64(recipientPublicKeyB64);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const ciphertext = nacl.box(
    decodeUTF8(plaintext),
    nonce,
    recipientPubKey,
    ephemeral.secretKey
  );

  const blob = new Uint8Array(32 + 24 + ciphertext.length);
  blob.set(ephemeral.publicKey, 0);
  blob.set(nonce, 32);
  blob.set(ciphertext, 56);

  return E2E_PREFIX + encodeBase64(blob);
}

export async function decryptMessage(
  payload: string,
  privateKey: CryptoKey
): Promise<string | null> {
  if (!payload.startsWith(E2E_PREFIX)) return null;
  try {
    const blob = decodeBase64(payload.slice(E2E_PREFIX.length));
    const ephPub = blob.slice(0, 32);
    const nonce = blob.slice(32, 56);
    const ciphertext = blob.slice(56);

    const sharedKey = await deriveBoxSharedKey(privateKey, ephPub);
    const plainBytes = nacl.box.open.after(ciphertext, nonce, sharedKey);
    if (!plainBytes) return null;
    return encodeUTF8(plainBytes);
  } catch {
    return null;
  }
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith(E2E_PREFIX);
}

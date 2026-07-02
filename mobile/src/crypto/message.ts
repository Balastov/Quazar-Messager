/**
 * E2E шифрование сообщений (mobile).
 * Та же схема, что и в web: X25519 + XSalsa20-Poly1305.
 * Формат: "ENC1:" + base64( eph_pub[32] || nonce[24] || ciphertext )
 */
import {
  crypto_box_easy,
  crypto_box_open_easy,
  crypto_box_keypair,
  randombytes_buf,
  crypto_box_NONCEBYTES,
  from_base64,
  to_base64,
  from_string,
  to_string,
  ready,
} from 'react-native-libsodium';

export const E2E_PREFIX = 'ENC1:';

export async function encryptMessage(
  plaintext: string,
  recipientPublicKeyB64: string,
): Promise<string> {
  await ready;
  const recipientPubKey = from_base64(recipientPublicKeyB64);
  const ephemeral = crypto_box_keypair();
  const nonce = randombytes_buf(crypto_box_NONCEBYTES);

  const ciphertext = crypto_box_easy(
    from_string(plaintext),
    nonce,
    recipientPubKey,
    ephemeral.privateKey,
  );

  const blob = new Uint8Array(32 + 24 + ciphertext.length);
  blob.set(ephemeral.publicKey, 0);
  blob.set(nonce, 32);
  blob.set(ciphertext, 56);

  return E2E_PREFIX + to_base64(blob);
}

export async function decryptMessage(
  payload: string,
  myPrivateKeyB64: string,
): Promise<string | null> {
  if (!payload.startsWith(E2E_PREFIX)) {return null;}
  try {
    await ready;
    const blob = from_base64(payload.slice(E2E_PREFIX.length));
    const ephPub = blob.slice(0, 32);
    const nonce = blob.slice(32, 56);
    const ciphertext = blob.slice(56);
    const myPrivKey = from_base64(myPrivateKeyB64);
    const plainBytes = crypto_box_open_easy(ciphertext, nonce, ephPub, myPrivKey);
    return to_string(plainBytes);
  } catch {
    return null;
  }
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith(E2E_PREFIX);
}

/**
 * E2E шифрование сообщений (mobile).
 * Та же схема, что и в web: X25519 + XSalsa20-Poly1305.
 *
 * ENC1: "ENC1:" + base64( eph_pub[32] || nonce[24] || ciphertext )
 * ENC2: "ENC2:" + base64( u32be(len_r) || box_r || u32be(len_s) || box_s )
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
export const E2E_PREFIX_V2 = 'ENC2:';

function writeU32BE(view: Uint8Array, offset: number, value: number): void {
  view[offset] = (value >>> 24) & 0xff;
  view[offset + 1] = (value >>> 16) & 0xff;
  view[offset + 2] = (value >>> 8) & 0xff;
  view[offset + 3] = value & 0xff;
}

function readU32BE(view: Uint8Array, offset: number): number {
  return (
    ((view[offset] << 24) |
      (view[offset + 1] << 16) |
      (view[offset + 2] << 8) |
      view[offset + 3]) >>>
    0
  );
}

async function sealBox(
  plaintext: string,
  recipientPublicKeyB64: string,
): Promise<Uint8Array> {
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
  return blob;
}

async function openBox(
  blob: Uint8Array,
  myPrivateKeyB64: string,
): Promise<string | null> {
  if (blob.length < 56) {return null;}
  try {
    await ready;
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

function parseEnc2Boxes(payload: string): Uint8Array[] | null {
  try {
    const raw = from_base64(payload.slice(E2E_PREFIX_V2.length));
    if (raw.length < 8) {return null;}

    const lenR = readU32BE(raw, 0);
    if (lenR === 0 || 4 + lenR + 4 > raw.length) {return null;}
    const boxR = raw.slice(4, 4 + lenR);

    const lenS = readU32BE(raw, 4 + lenR);
    const startS = 8 + lenR;
    if (lenS === 0 || startS + lenS !== raw.length) {return null;}
    const boxS = raw.slice(startS, startS + lenS);

    return [boxR, boxS];
  } catch {
    return null;
  }
}

/**
 * Шифрует для получателя и (если передан) для отправителя.
 */
export async function encryptMessage(
  plaintext: string,
  recipientPublicKeyB64: string,
  senderPublicKeyB64?: string,
): Promise<string> {
  const forRecipient = await sealBox(plaintext, recipientPublicKeyB64);

  if (!senderPublicKeyB64) {
    return E2E_PREFIX + to_base64(forRecipient);
  }

  const forSender = await sealBox(plaintext, senderPublicKeyB64);
  const blob = new Uint8Array(4 + forRecipient.length + 4 + forSender.length);
  writeU32BE(blob, 0, forRecipient.length);
  blob.set(forRecipient, 4);
  writeU32BE(blob, 4 + forRecipient.length, forSender.length);
  blob.set(forSender, 8 + forRecipient.length);

  return E2E_PREFIX_V2 + to_base64(blob);
}

export async function decryptMessage(
  payload: string,
  myPrivateKeyB64: string,
): Promise<string | null> {
  try {
    if (payload.startsWith(E2E_PREFIX_V2)) {
      const boxes = parseEnc2Boxes(payload);
      if (!boxes) {return null;}
      for (const box of boxes) {
        const plain = await openBox(box, myPrivateKeyB64);
        if (plain !== null) {return plain;}
      }
      return null;
    }

    if (payload.startsWith(E2E_PREFIX)) {
      const blob = from_base64(payload.slice(E2E_PREFIX.length));
      return openBox(blob, myPrivateKeyB64);
    }

    return null;
  } catch {
    return null;
  }
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith(E2E_PREFIX_V2) || payload.startsWith(E2E_PREFIX);
}

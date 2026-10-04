/**
 * E2E шифрование сообщений (web).
 * Схема: X25519 + XSalsa20-Poly1305 (NaCl crypto_box via tweetnacl)
 *
 * ENC1: "ENC1:" + base64( eph_pub[32] || nonce[24] || ciphertext[n+16] )
 *   — только для получателя (legacy).
 *
 * ENC2: "ENC2:" + base64(
 *   u32be(len_r) || box_r || u32be(len_s) || box_s
 * )
 *   — box_r для получателя, box_s для отправителя (тот же plaintext).
 */
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from "tweetnacl-util";
import { deriveBoxSharedKey } from "./webcrypto";

export const E2E_PREFIX = "ENC1:";
export const E2E_PREFIX_V2 = "ENC2:";

function sealBox(plaintext: string, recipientPublicKeyB64: string): Uint8Array {
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
  return blob;
}

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

/**
 * Шифрует сообщение для получателя и (если передан) для отправителя.
 * С senderPublicKeyB64 → ENC2, иначе → ENC1 (legacy).
 */
export function encryptMessage(
  plaintext: string,
  recipientPublicKeyB64: string,
  senderPublicKeyB64?: string
): string {
  const forRecipient = sealBox(plaintext, recipientPublicKeyB64);

  if (!senderPublicKeyB64) {
    return E2E_PREFIX + encodeBase64(forRecipient);
  }

  const forSender = sealBox(plaintext, senderPublicKeyB64);
  const blob = new Uint8Array(4 + forRecipient.length + 4 + forSender.length);
  writeU32BE(blob, 0, forRecipient.length);
  blob.set(forRecipient, 4);
  writeU32BE(blob, 4 + forRecipient.length, forSender.length);
  blob.set(forSender, 8 + forRecipient.length);

  return E2E_PREFIX_V2 + encodeBase64(blob);
}

async function openBox(
  blob: Uint8Array,
  opts: { seed?: Uint8Array | null; privateKey?: CryptoKey | null }
): Promise<string | null> {
  if (blob.length < 56) return null;
  const ephPub = blob.slice(0, 32);
  const nonce = blob.slice(32, 56);
  const ciphertext = blob.slice(56);

  if (opts.seed && opts.seed.length === 32) {
    const plainBytes = nacl.box.open(ciphertext, nonce, ephPub, opts.seed);
    if (!plainBytes) return null;
    return encodeUTF8(plainBytes);
  }

  if (opts.privateKey) {
    const sharedKey = await deriveBoxSharedKey(opts.privateKey, ephPub);
    const plainBytes = nacl.box.open.after(ciphertext, nonce, sharedKey);
    if (!plainBytes) return null;
    return encodeUTF8(plainBytes);
  }

  return null;
}

function parseEnc2Boxes(payload: string): Uint8Array[] | null {
  try {
    const raw = decodeBase64(payload.slice(E2E_PREFIX_V2.length));
    if (raw.length < 8) return null;

    const lenR = readU32BE(raw, 0);
    if (lenR === 0 || 4 + lenR + 4 > raw.length) return null;
    const boxR = raw.slice(4, 4 + lenR);

    const lenS = readU32BE(raw, 4 + lenR);
    const startS = 8 + lenR;
    if (lenS === 0 || startS + lenS !== raw.length) return null;
    const boxS = raw.slice(startS, startS + lenS);

    return [boxR, boxS];
  } catch {
    return null;
  }
}

export async function decryptMessage(
  payload: string,
  opts: { seed?: Uint8Array | null; privateKey?: CryptoKey | null }
): Promise<string | null> {
  try {
    if (payload.startsWith(E2E_PREFIX_V2)) {
      const boxes = parseEnc2Boxes(payload);
      if (!boxes) return null;
      for (const box of boxes) {
        const plain = await openBox(box, opts);
        if (plain !== null) return plain;
      }
      return null;
    }

    if (payload.startsWith(E2E_PREFIX)) {
      const blob = decodeBase64(payload.slice(E2E_PREFIX.length));
      return openBox(blob, opts);
    }

    return null;
  } catch {
    return null;
  }
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith(E2E_PREFIX_V2) || payload.startsWith(E2E_PREFIX);
}

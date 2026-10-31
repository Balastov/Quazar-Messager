/**
 * NaCl crypto_box на чистом JS (@noble) — побайтово совместим с nacl.box из web (tweetnacl)
 * и с libsodium crypto_box_easy: X25519 → HSalsa20 → XSalsa20-Poly1305, mac[16] || ciphertext.
 *
 * Случайные байты берутся из crypto.getRandomValues — на устройстве его даёт системный
 * генератор через react-native-get-random-values (подключён первым импортом в index.js).
 */
import {x25519} from '@noble/curves/ed25519';
import {hsalsa, xsalsa20poly1305} from '@noble/ciphers/salsa';

export const BOX_NONCE_BYTES = 24;

// «expand 32-byte k» — константа Salsa20, как в crypto_box_beforenm.
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

export function randomBytes(length: number): Uint8Array {
  const cryptoApi = (globalThis as {crypto?: {getRandomValues?: (a: Uint8Array) => Uint8Array}})
    .crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('crypto.getRandomValues недоступен');
  }
  return cryptoApi.getRandomValues(new Uint8Array(length));
}

function toWords(bytes: Uint8Array): Uint32Array {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] =
      bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
  }
  return words;
}

function toBytes(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    bytes[i * 4] = words[i] & 0xff;
    bytes[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    bytes[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    bytes[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return bytes;
}

/** crypto_box_beforenm: общий ключ XSalsa20-Poly1305 для пары ключей. */
function sharedKey(theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(mySecretKey, theirPublicKey);
  const out = new Uint32Array(8);
  hsalsa(SIGMA, toWords(shared), new Uint32Array(4), out);
  return toBytes(out);
}

export function boxKeyPair(): {publicKey: Uint8Array; secretKey: Uint8Array} {
  const secretKey = randomBytes(32);
  return {publicKey: x25519.getPublicKey(secretKey), secretKey};
}

export function box(
  message: Uint8Array,
  nonce: Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Uint8Array {
  return xsalsa20poly1305(sharedKey(theirPublicKey, mySecretKey), nonce).encrypt(message);
}

/** null — не тот ключ или сообщение подделано. */
export function boxOpen(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Uint8Array | null {
  try {
    return xsalsa20poly1305(sharedKey(theirPublicKey, mySecretKey), nonce).decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** UTF-8 → строка. В Hermes нет TextDecoder; битые последовательности — ошибка, как у libsodium. */
export function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let code: number;
    let extra: number;
    if (b < 0x80) {
      code = b;
      extra = 0;
    } else if (b >= 0xc2 && b < 0xe0) {
      code = b & 0x1f;
      extra = 1;
    } else if (b >= 0xe0 && b < 0xf0) {
      code = b & 0x0f;
      extra = 2;
    } else if (b >= 0xf0 && b < 0xf5) {
      code = b & 0x07;
      extra = 3;
    } else {
      throw new Error('Invalid UTF-8');
    }
    if (i + extra >= bytes.length) {
      throw new Error('Invalid UTF-8');
    }
    for (let k = 1; k <= extra; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) {
        throw new Error('Invalid UTF-8');
      }
      code = (code << 6) | (c & 0x3f);
    }
    if (
      (extra === 2 && (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))) ||
      (extra === 3 && (code < 0x10000 || code > 0x10ffff))
    ) {
      throw new Error('Invalid UTF-8');
    }
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

import {x25519} from '@noble/curves/ed25519';
import {encodeB64} from './base64';

/**
 * Публичный X25519-ключ из секретного (= seed в резервной копии).
 * То же, что nacl.box.keyPair.fromSecretKey в web: один seed → один ключ на всех устройствах.
 */
export function publicKeyFromSecret(secret: Uint8Array): string {
  if (secret.length !== 32) {
    throw new Error('Invalid secret key length');
  }
  return encodeB64(x25519.getPublicKey(secret));
}

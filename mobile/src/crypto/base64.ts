/**
 * Стандартный base64 (с паддингом) — как в web-клиенте и на бэкенде.
 * По умолчанию react-native-libsodium использует URL-safe без паддинга,
 * который сервер и web не принимают.
 */
import {base64_variants, from_base64, to_base64} from 'react-native-libsodium';

export function encodeB64(bytes: Uint8Array): string {
  // slice(): libsodium кодирует весь underlying buffer, а не только view.
  return to_base64(bytes.slice(), base64_variants.ORIGINAL);
}

/** Принимает и стандартный, и URL-safe base64 (так писали старые версии клиента). */
export function decodeB64(input: string): Uint8Array {
  let normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) {
    normalized += '=';
  }
  return from_base64(normalized, base64_variants.ORIGINAL);
}

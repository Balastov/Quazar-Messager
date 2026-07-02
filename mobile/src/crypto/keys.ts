/**
 * Управление ключами E2E (mobile).
 *
 * Хранилище: AsyncStorage (MVP).
 * Продакшн: react-native-keychain (Keychain на iOS / Keystore на Android).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  crypto_box_keypair,
  from_base64,
  to_base64,
  ready,
} from 'react-native-libsodium';
import {http} from '../api/client';

const KEY_PRIVATE = 'quazar_e2e_priv';
const KEY_PUBLIC = 'quazar_e2e_pub';

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

async function ensureReady() {
  await ready;
}

export async function generateAndSaveKeys(): Promise<KeyPair> {
  await ensureReady();
  const kp = crypto_box_keypair();
  const pair: KeyPair = {
    publicKey: to_base64(kp.publicKey),
    privateKey: to_base64(kp.privateKey),
  };
  await AsyncStorage.multiSet([
    [KEY_PUBLIC, pair.publicKey],
    [KEY_PRIVATE, pair.privateKey],
  ]);
  return pair;
}

export async function loadOrCreateKeys(): Promise<KeyPair> {
  const [[, pub], [, priv]] = await AsyncStorage.multiGet([KEY_PUBLIC, KEY_PRIVATE]);
  if (pub && priv) {return {publicKey: pub, privateKey: priv};}
  return generateAndSaveKeys();
}

export async function uploadPublicKey(publicKey: string): Promise<void> {
  await http.put('/users/me/key', {public_key: publicKey});
}

const _keyCache = new Map<string, string>();

export async function fetchUserPublicKey(userId: string): Promise<string | null> {
  if (_keyCache.has(userId)) {return _keyCache.get(userId)!;}
  try {
    const {data} = await http.get<{user_id: string; public_key: string | null}>(
      `/users/${userId}/key`,
    );
    if (data.public_key) {
      _keyCache.set(userId, data.public_key);
      return data.public_key;
    }
    return null;
  } catch {
    return null;
  }
}

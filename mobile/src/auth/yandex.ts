/**
 * Вход через Яндекс ID в мобильном приложении: системный браузер → Яндекс → сервер →
 * quazar://auth/yandex#code=… (формат — backend/app/api/oauth.py).
 *
 * Ссылку quazar:// может зарегистрировать и чужое приложение, поэтому код привязан к секрету
 * этого устройства: на сервер уходит только sha256 секрета (challenge), а обменять код на
 * сессию можно, лишь предъявив сам секрет.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Linking} from 'react-native';
import {sha256} from '@noble/hashes/sha2';
import {utf8ToBytes} from '@noble/hashes/utils';
import {randombytes_buf, ready} from 'react-native-libsodium';
import {API_BASE_URL} from '../api/client';
import {encodeB64} from '../crypto/base64';

const VERIFIER_KEY = 'quazar.yandexVerifier';
export const RETURN_PREFIX = 'quazar://auth/yandex';

function base64url(bytes: Uint8Array): string {
  return encodeB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Открыть вход через Яндекс в браузере. Секрет хранится до возвращения (приложение могут выгрузить). */
export async function startYandexLogin(): Promise<void> {
  await ready;
  const verifier = base64url(randombytes_buf(32));
  await AsyncStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = base64url(sha256(utf8ToBytes(verifier)));
  await Linking.openURL(`${API_BASE_URL}/auth/yandex/start?client=mobile&challenge=${challenge}`);
}

export async function storedVerifier(): Promise<string | null> {
  return AsyncStorage.getItem(VERIFIER_KEY);
}

export async function forgetVerifier(): Promise<void> {
  await AsyncStorage.removeItem(VERIFIER_KEY);
}

/** Параметры после «#» из ссылки возврата; не наша ссылка — null. */
export function parseReturnUrl(url: string | null): Record<string, string> | null {
  if (!url || !url.startsWith(RETURN_PREFIX)) {
    return null;
  }
  const hash = url.indexOf('#');
  const out: Record<string, string> = {};
  if (hash < 0) {
    return out;
  }
  for (const pair of url.slice(hash + 1).split('&')) {
    const [key, value = ''] = pair.split('=');
    if (key) {
      out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
    }
  }
  return out;
}

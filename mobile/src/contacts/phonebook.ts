/**
 * Телефонная книга устройства (iOS и Android) через react-native-contacts.
 * На Android разрешение спрашиваем через PermissionsAndroid, на iOS — у самой библиотеки.
 */
import {PermissionsAndroid, Platform} from 'react-native';
import Contacts from 'react-native-contacts';
import type {PhonebookEntry} from '../api/contacts';

export type PhonebookPermission = 'granted' | 'denied' | 'blocked' | 'undetermined';

const ANDROID_PERMISSION = PermissionsAndroid.PERMISSIONS.READ_CONTACTS;

/** Не спрашивая: есть ли доступ. */
export async function phonebookPermission(): Promise<PhonebookPermission> {
  if (Platform.OS === 'android') {
    return (await PermissionsAndroid.check(ANDROID_PERMISSION)) ? 'granted' : 'undetermined';
  }
  const status = await Contacts.checkPermission();
  if (status === 'authorized') {
    return 'granted';
  }
  // iOS спрашивает один раз; после отказа — только через «Настройки».
  return status === 'denied' ? 'blocked' : 'undetermined';
}

/** Системный запрос доступа. */
export async function requestPhonebookPermission(): Promise<PhonebookPermission> {
  if (Platform.OS === 'android') {
    const result = await PermissionsAndroid.request(ANDROID_PERMISSION, {
      title: 'Контакты',
      message:
        'Quazar найдёт среди ваших контактов тех, кто уже пользуется мессенджером. ' +
        'Номера сверяются на сервере и не сохраняются.',
      buttonPositive: 'Разрешить',
      buttonNegative: 'Не сейчас',
    });
    if (result === PermissionsAndroid.RESULTS.GRANTED) {
      return 'granted';
    }
    return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
  }
  const status = await Contacts.requestPermission();
  return status === 'authorized' ? 'granted' : 'blocked';
}

/** Имена и номера из книги — без фото, почты и адресов. */
export async function readPhonebook(): Promise<PhonebookEntry[]> {
  const all = await Contacts.getAllWithoutPhotos();
  const entries: PhonebookEntry[] = [];
  for (const c of all) {
    const phones = [...new Set((c.phoneNumbers ?? []).map(p => p.number).filter(Boolean))].slice(0, 10);
    if (!phones.length) {
      continue;
    }
    const name =
      c.displayName?.trim() ||
      [c.givenName, c.middleName, c.familyName].filter(Boolean).join(' ').trim() ||
      c.company?.trim() ||
      '';
    entries.push({name, phones});
  }
  return entries.slice(0, 5000);
}

/**
 * Contact Picker API — выбор контактов из книги телефона.
 * Работает в основном в Chrome на Android (HTTPS). Полный доступ ко всей
 * книге без выбора пользователя браузеры не дают.
 */

export type PickedContact = {
  name?: string;
  tel?: string;
};

function getContactsManager(): ContactsManager | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { contacts?: ContactsManager };
  return nav.contacts ?? null;
}

export function isContactPickerSupported(): boolean {
  const contacts = getContactsManager();
  return typeof contacts?.select === "function";
}

/** Открывает системный выбор контакта и возвращает первый телефон. */
export async function pickPhoneFromDeviceContacts(): Promise<PickedContact | null> {
  const contacts = getContactsManager();
  if (!contacts?.select) return null;

  try {
    const selected = await contacts.select(["name", "tel"], { multiple: false });
    const first = selected?.[0];
    if (!first) return null;
    const tel = Array.isArray(first.tel) ? first.tel[0] : undefined;
    const name = Array.isArray(first.name) ? first.name[0] : undefined;
    if (!tel) return { name };
    return { name, tel };
  } catch {
    // Пользователь отменил или API недоступен
    return null;
  }
}

/** Minimal typings — lib.dom may not include ContactsManager everywhere. */
interface ContactsManager {
  select(
    properties: string[],
    options?: { multiple?: boolean }
  ): Promise<Array<{ name?: string[]; tel?: string[] }>>;
}

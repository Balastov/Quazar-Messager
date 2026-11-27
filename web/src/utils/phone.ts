import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Номера телефонов. Российские (+7, 8…, 10 цифр) — по-прежнему маской +7 (999) 000-00-00;
 * номер другой страны вводится с «+» и кодом страны и форматируется по базе libphonenumber.
 * На сервер уходит E.164 (+79991234567, +447911123456).
 */

const MAX_DIGITS = 15; // E.164

export function extractRuLocalDigits(input: string): string {
  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("8")) digits = digits.slice(1);
  if (digits.startsWith("7")) digits = digits.slice(1);
  return digits.slice(0, 10);
}

/** Format as +7 (999) 000-00-00 while typing */
export function formatRuPhoneMask(input: string): string {
  const d = extractRuLocalDigits(input);
  const p1 = d.slice(0, 3);
  const p2 = d.slice(3, 6);
  const p3 = d.slice(6, 8);
  const p4 = d.slice(8, 10);

  let out = "+7";
  if (p1) out += ` (${p1}`;
  if (p1.length === 3) out += ")";
  if (p2) out += ` ${p2}`;
  if (p3) out += `-${p3}`;
  if (p4) out += `-${p4}`;
  return out;
}

/** Convert mask/input to +7XXXXXXXXXX or null if incomplete */
export function toE164Ru(input: string): string | null {
  const d = extractRuLocalDigits(input);
  if (d.length !== 10) return null;
  return `+7${d}`;
}

/** «00» в начале — международный выход, как «+». */
function withPlus(input: string): string {
  const t = input.trim();
  return t.startsWith("00") ? `+${t.slice(2)}` : t;
}

/** Набирают номер другой страны: «+» и код страны не 7. */
export function isForeignPhoneInput(input: string): boolean {
  return /^\+[\s(]*[0-689]/.test(withPlus(input));
}

/** Маска поля номера при наборе: +7 (999) 000-00-00 или +44 7911 123456. */
export function formatPhoneInput(input: string): string {
  const t = withPlus(input);
  if (/^\+[\s(]*$/.test(t)) return "+";
  if (isForeignPhoneInput(t)) return new AsYouType().input(`+${t.replace(/\D/g, "").slice(0, MAX_DIGITS)}`);
  return formatRuPhoneMask(t);
}

/** Полный номер в E.164 или null, пока номер не набран целиком. Без «+» номер считается российским. */
export function toE164(input: string): string | null {
  const t = withPlus(input);
  const digits = t.replace(/\D/g, "");
  if (isForeignPhoneInput(t)) {
    if (digits.length > MAX_DIGITS) return null;
    const parsed = parsePhoneNumberFromString(`+${digits}`);
    return parsed?.isValid() ? parsed.number : null;
  }
  if (t.startsWith("+")) return toE164Ru(t);
  if ((digits.length === 11 && /^[78]/.test(digits)) || digits.length === 10) return `+7${digits.slice(-10)}`;
  return null;
}

export function isCompletePhone(input: string): boolean {
  return toE164(input) !== null;
}

/** Номер другой страны (не +7). Как его подтвердят — auth/phoneMethod.ts. */
export function isForeignPhone(phone: string): boolean {
  return /^\+[0-689]/.test(phone);
}

/** Сохранённый номер для показа: +7 (999) 123-45-67, +44 7911 123456. */
export function formatPhoneDisplay(input: string | null | undefined): string {
  if (!input) return "";
  if (isForeignPhone(input)) return parsePhoneNumberFromString(input)?.formatInternational() ?? input;
  const e164 = toE164Ru(input) ?? (input.startsWith("+7") && input.length >= 12 ? input : null);
  if (!e164) return input;
  return formatRuPhoneMask(e164);
}

/** Цифры номера для поиска по подстроке: у российского — без 8/7 в начале, у иностранного — все. */
export function phoneSearchDigits(input: string): string {
  if (isForeignPhoneInput(input)) return input.replace(/\D/g, "").slice(0, MAX_DIGITS);
  return extractRuLocalDigits(input);
}

/** Query looks like a phone fragment (enough digits to search). */
export function looksLikePhoneQuery(input: string): boolean {
  return phoneSearchDigits(input).length >= 3;
}

/** Whether the search box has enough input to query the API. */
export function canSearchUsers(input: string): boolean {
  const q = input.trim();
  if (!q) return false;
  const digits = phoneSearchDigits(q);
  const mostlyPhone = digits.length > 0 && digits.length >= q.replace(/\s/g, "").replace(/[+\-()]/g, "").length * 0.6;
  if (mostlyPhone || looksLikePhoneQuery(q)) {
    return digits.length >= 3;
  }
  return q.length >= 2;
}

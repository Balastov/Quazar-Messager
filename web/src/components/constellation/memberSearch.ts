/**
 * Поиск в списке участников Звезды: по никнейму, имени и фамилии, псевдониму — сразу, на месте.
 * Телефонов участников у приложения нет (иначе их видели бы все в Звезде), поэтому номер
 * проверяет сервер — как в «Контактах»: только целиком и только у тех, кто не скрыл номер.
 */
import type { StarMember } from "../../api/stars";
import { phoneSearchDigits, toE164 } from "../../utils/phone";

/** Без регистра, «ё» = «е». */
export function normalizeSearch(text: string): string {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
}

/** Каждое слово запроса — часть никнейма, имени и фамилии или псевдонима (в любом порядке). */
export function matchesMember(member: StarMember, query: string): boolean {
  const words = normalizeSearch(query).split(/\s+/).map((w) => w.replace(/^@/, "")).filter(Boolean);
  if (!words.length) return true;
  const u = member.user;
  const haystack = normalizeSearch(
    [u.username, u.display_name, u.account_display_name, u.pseudonym].filter(Boolean).join("\n")
  );
  return words.every((w) => haystack.includes(w));
}

/** Запрос похож на номер: только цифры, пробелы, «+», «-», скобки. */
function phoneLike(query: string): boolean {
  const q = query.trim();
  return /^[\d\s+\-()]+$/.test(q) && /\d/.test(q);
}

/** Полный номер в E.164 — его можно проверить на сервере; иначе null. */
export function phoneQuery(query: string): string | null {
  return phoneLike(query) ? toE164(query) : null;
}

/** Набрали кусок номера — подскажем, что ищем только целиком. */
export function isPartialPhone(query: string): boolean {
  if (!phoneLike(query)) return false;
  return phoneSearchDigits(query).length >= 3 && !toE164(query);
}

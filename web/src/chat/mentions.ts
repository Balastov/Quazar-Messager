// @упоминания: разбор как на сервере (backend/app/core/notify.py → parse_mentions) и подсказка при вводе.

/** @все — всем (в Звёздах — только от модераторов и выше). */
export const ALL_WORDS = ["все", "all", "everyone", "here"];

const MENTION = /(^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}_.]{2,64})/gu;

export type MentionPart = { type: "text"; text: string } | { type: "mention"; text: string; name: string };

/** Текст кусками: обычный текст и @имя (имя — как написано, без «@» и точки в конце). */
export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = (m.index ?? 0) + m[1].length;
    let name = m[2];
    while (name.endsWith(".")) name = name.slice(0, -1);
    if (name.length < 2) continue;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "mention", text: `@${name}`, name });
    last = start + 1 + name.length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

export function isAllWord(name: string): boolean {
  return ALL_WORDS.includes(name.toLowerCase());
}

/** Упомянут ли человек в тексте (по имени, без учёта регистра; @все — да). */
export function mentionsName(text: string, username: string, withAll = true): boolean {
  const me = username.toLowerCase();
  return splitMentions(text).some(
    (p) => p.type === "mention" && (p.name.toLowerCase() === me || (withAll && isAllWord(p.name)))
  );
}

/** Курсор стоит в «@на…» — что подсказывать. null — не в упоминании. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (!/^[\p{L}\p{N}_.]{0,64}$/u.test(query)) return null;
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && /[\p{L}\p{N}_@.]/u.test(prev)) return null;
  return { start: at, query };
}

/** Подставить «@имя » вместо набранного «@на». */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  const rest = text.slice(caret).replace(/^[\p{L}\p{N}_.]*/u, "");
  const next = text.slice(0, start) + insert + rest.replace(/^ /, "");
  return { text: next, caret: start + insert.length };
}

/** Кого подсказать: сначала начинающиеся с запроса, потом содержащие; не больше limit. */
export function suggestNames(names: string[], query: string, limit = 6): string[] {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

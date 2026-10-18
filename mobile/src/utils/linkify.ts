/**
 * Находит ссылки в тексте сообщения: https://…, http://…, www.… и голые домены
 * с известной зоной (quazar-msg.ru, пример.рф/путь). Те же правила, что в web/src/utils/linkify.ts.
 *
 * Без `new URL` (в React Native он неполный) и без \p{…} в регулярках (Hermes).
 */

export type TextPart = {type: 'text'; text: string} | {type: 'link'; text: string; href: string};

/** Зоны, при которых «слово.зона» считаем ссылкой. Без .js/.py/.md — это чаще файлы. */
const TLDS = new Set(
  (
    'ru рф su com net org io me dev app info biz tv co uk de by kz ua uz am ge xyz ai gg ly to ' +
    'site online store shop tech pro edu gov us eu cc fm so sh page link live news blog cloud ' +
    'games art space website moscow'
  ).split(' '),
);

const L = '0-9a-zа-яёA-ZА-ЯЁ';
const SCHEME_RE = /https?:\/\//i;
const LEADING_RE = /^[(«"'[{<]+/;
const TRAILING = new Set(['.', ',', '!', '?', ';', ':', '…', '»', '"', "'", ')', ']', '}', '>']);
const LABELS = `(?:[${L}](?:[${L}-]*[${L}])?\\.)+`;
const BARE_RE = new RegExp(`^(${LABELS})([a-zа-яёA-ZА-ЯЁ]{2,24})(:\\d{2,5})?([/?#].*)?$`);
const HOST_RE = new RegExp(`^(${LABELS}[a-zа-яёA-ZА-ЯЁ]{2,24}|localhost)(:\\d{2,5})?([/?#].*)?$`);

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) {
    if (c === ch) {
      n++;
    }
  }
  return n;
}

/** Убирает хвостовую пунктуацию: «см. https://x.ru/a).» → https://x.ru/a. Скобки — если без пары. */
function trimTrailing(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1];
    if (!TRAILING.has(ch)) {
      break;
    }
    if (ch === ')' && count(s.slice(0, end), '(') >= count(s.slice(0, end), ')')) {
      break;
    }
    end--;
  }
  return s.slice(0, end);
}

/** Адрес для открытия, если candidate — ссылка; иначе null. */
function toHref(candidate: string): string | null {
  const scheme = /^https?:\/\//i.exec(candidate);
  if (scheme) {
    return HOST_RE.test(candidate.slice(scheme[0].length)) ? candidate : null;
  }
  if (/^www\./i.test(candidate)) {
    return HOST_RE.test(candidate) ? `https://${candidate}` : null;
  }
  if (candidate.includes('@')) {
    return null; // почта
  }
  const m = BARE_RE.exec(candidate);
  if (!m || !TLDS.has(m[2].toLowerCase())) {
    return null;
  }
  return `https://${candidate}`;
}

function pushText(parts: TextPart[], text: string) {
  if (!text) {
    return;
  }
  const last = parts[parts.length - 1];
  if (last?.type === 'text') {
    last.text += text;
  } else {
    parts.push({type: 'text', text});
  }
}

/** Ссылку в одном слове (без пробелов): «(см.https://x.ru)» → текст, ссылка, текст. */
function splitWord(word: string, parts: TextPart[]) {
  // Ссылка, приклеенная к слову: «тут:https://…».
  const at = word.search(SCHEME_RE);
  const prefix = at > 0 ? word.slice(0, at) : LEADING_RE.exec(word)?.[0] ?? '';
  const rest = word.slice(prefix.length);
  const candidate = trimTrailing(rest);
  const href = candidate ? toHref(candidate) : null;
  if (!href) {
    pushText(parts, word);
    return;
  }
  pushText(parts, prefix);
  parts.push({type: 'link', text: candidate, href});
  pushText(parts, rest.slice(candidate.length));
}

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  for (const chunk of text.split(/(\s+)/)) {
    if (!chunk || /^\s+$/.test(chunk)) {
      pushText(parts, chunk);
    } else {
      splitWord(chunk, parts);
    }
  }
  return parts;
}

// Профиль: имя для показа и правила никнейма — как на сервере (backend/app/core/profile.py).

export const USERNAME_MAX = 32;

const RESERVED = new Set([
  'all', 'everyone', 'here', 'admin', 'administrator', 'support', 'system', 'quazar',
  'moderator', 'root', 'me', 'saved',
]);

type Named = {username: string; display_name?: string | null};

/** «Имя Фамилия», если указаны, иначе никнейм. Нет пользователя — undefined (для «?? запасное»). */
export function displayName(u: Named): string;
export function displayName(u: Named | null | undefined): string | undefined;
export function displayName(u: Named | null | undefined): string | undefined {
  if (!u) {
    return undefined;
  }
  return u.display_name?.trim() || u.username;
}

// Hermes может не знать Intl.Segmenter — тогда делим по символам Unicode.
type Segmenter = {segment(text: string): Iterable<{segment: string}>};
const SegmenterClass = (Intl as unknown as {Segmenter?: new (locale: undefined, options: {granularity: 'grapheme'}) => Segmenter}).Segmenter;
const graphemes = SegmenterClass ? new SegmenterClass(undefined, {granularity: 'grapheme'}) : null;

function firstGraphemes(word: string, count: number): string {
  const parts = graphemes ? Array.from(graphemes.segment(word), part => part.segment) : Array.from(word);
  return parts.slice(0, count).join('');
}

const EMOJI_START = /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const LETTER_START = /^[\p{L}\p{N}]/u;

/**
 * Буквы для аватара без фото — как в веб-версии: «Имя Фамилия» → «ИФ», одно слово — первые две буквы,
 * имени нет (передан никнейм) — первые две буквы никнейма. Начинается с эмодзи — только эмодзи.
 */
export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words[0] && EMOJI_START.test(words[0])) {return firstGraphemes(words[0], 1);}
  const letters = words.filter(word => LETTER_START.test(word));
  if (!letters.length) {return '?';}
  const value = letters.length > 1
    ? firstGraphemes(letters[0], 1) + firstGraphemes(letters[1], 1)
    : firstGraphemes(letters[0], 2);
  return value.toUpperCase();
}

const nameCollator = new Intl.Collator('ru', {sensitivity: 'accent', numeric: true});

function alphabetGroup(name: string): number {
  if (/^\p{Script=Cyrillic}/u.test(name)) {return 0;}
  if (/^\p{Script=Latin}/u.test(name)) {return 1;}
  return 2;
}

/** По первой букве: кириллица, латиница, остальные символы; регистр не влияет. */
export function compareNames(a: string, b: string): number {
  const left = a.trim().normalize('NFC');
  const right = b.trim().normalize('NFC');
  return alphabetGroup(left) - alphabetGroup(right) || nameCollator.compare(left, right);
}

/** Отображаемое имя, иначе никнейм. При одинаковых именах сравниваем никнеймы. */
export function compareUsers(a: Named, b: Named): number {
  return compareNames(displayName(a), displayName(b)) || compareNames(a.username, b.username);
}

/** Что не так с никнеймом (без похода на сервер); null — по правилам подходит. */
export function usernameProblem(raw: string): string | null {
  const v = raw.trim().replace(/^@/, '');
  if (v.length < 3 || v.length > USERNAME_MAX) {
    return `Никнейм — от 3 до ${USERNAME_MAX} символов`;
  }
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(v)) {
    return 'Никнейм — латинские буквы, цифры, «_» и «.», начинается с буквы';
  }
  if (v.endsWith('.') || v.includes('..')) {
    return 'Точка не может стоять в конце никнейма или два раза подряд';
  }
  if (RESERVED.has(v.toLowerCase())) {
    return 'Этот никнейм зарезервирован';
  }
  return null;
}

/** Текст ошибки API: detail строкой или первая ошибка валидации без «Value error, ». */
export function apiErrorText(err: unknown, fallback = 'Что-то пошло не так'): string {
  const detail = (err as {response?: {data?: {detail?: string | {msg?: string}[]}}})?.response
    ?.data?.detail;
  if (typeof detail === 'string') {
    return detail;
  }
  if (Array.isArray(detail) && detail[0]?.msg) {
    return String(detail[0].msg).replace(/^Value error, /, '');
  }
  return fallback;
}

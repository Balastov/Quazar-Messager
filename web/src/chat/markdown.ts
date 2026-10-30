/**
 * Разметка сообщений — подмножество Markdown, разбирается на клиенте (сервер видит только
 * шифротекст, разметка ему не нужна):
 *
 *   **жирный**  *курсив* или _курсив_  ~~зачёркнутый~~ или ~зачёркнутый~  `код`
 *   ```lang        > цитата        - пункт / * пункт / • пункт        1. пункт
 *   блок кода
 *   ```
 *
 * Выделение не переходит через строку и не начинается внутри слова: snake_case, 2*3*4 и
 * адреса ссылок остаются как есть. Без \p{…} и lookbehind — те же правила в мобильной копии.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "bold" | "italic" | "strike"; children: Inline[] };

export type Block =
  | { t: "para"; children: Inline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; children: Block[] }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  // Только в заметках Спутника (parseBlocks(text, { headings: true })): «# Заголовок» и «---».
  | { t: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { t: "rule" };

export interface BlockOptions {
  /** «# », «## », «### » — заголовки, «---» — черта. В сообщениях выключено: «# 1» в чате — не заголовок. */
  headings?: boolean;
}

// Закрывающие «#» — только через пробел: «# Язык C#» остаётся как есть.
const HEADING_RE = /^(#{1,3}) +(.+?)(?: +#+)? *$/;
const RULE_RE = /^ *(?:-{3,}|\*{3,}|_{3,}) *$/;

export interface ListItem {
  /** Номер пункта нумерованного списка — как написал автор. */
  n: number;
  /** Отступ: 0 — верхний уровень. */
  depth: number;
  children: Inline[];
}

type Mark = "bold" | "italic" | "strike";

/** Разделители по убыванию длины: «**» раньше «*». */
const DELIMS: [string, Mark][] = [
  ["**", "bold"],
  ["~~", "strike"],
  ["*", "italic"],
  ["_", "italic"],
  ["~", "strike"],
];

const FENCE = "```";
const LANG_RE = /^[A-Za-z0-9+#._-]{1,20}$/;
const BULLET_RE = /^( *)[-*•] +(.*)$/;
const ORDERED_RE = /^( *)(\d{1,4})[.)] +(.*)$/;
const URL_START_RE = /^(?:https?:\/\/|www\.)/i;

/** Буква любого алфавита, цифра или «_»: у букв верхний и нижний регистр различаются. */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return ch === "_" || (ch >= "0" && ch <= "9") || ch.toLowerCase() !== ch.toUpperCase();
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === " ";
}

/** Конец ссылки, начинающейся в from: до пробела, без хвоста из знаков разметки. */
function urlEnd(s: string, from: number): number {
  let end = from;
  while (end < s.length && !isSpace(s[end])) end++;
  while (end > from && "*_~`".includes(s[end - 1])) end--;
  return end;
}

/** Где закрывается код из n обратных кавычек, начатый в from; -1 — не закрыт. */
function codeEnd(s: string, from: number, n: number): number {
  let j = from;
  while (j < s.length) {
    const at = s.indexOf("`", j);
    if (at < 0) return -1;
    let run = 0;
    while (s[at + run] === "`") run++;
    if (run === n) return at;
    j = at + run;
  }
  return -1;
}

function backticks(s: string, i: number): number {
  let n = 0;
  while (s[i + n] === "`") n++;
  return n;
}

/** Начинается ли в i ссылка, которую нельзя резать разметкой. */
function urlAt(s: string, i: number): boolean {
  const prev = s[i - 1];
  return (i === 0 || isSpace(prev) || "*_~(«\"'[".includes(prev)) && URL_START_RE.test(s.slice(i, i + 12));
}

function canOpen(s: string, i: number, d: string): boolean {
  if (!s.startsWith(d, i)) return false;
  const prev = s[i - 1];
  const next = s[i + d.length];
  if (isWordChar(prev) || isSpace(next)) return false;
  // Одиночный «*» или «~» — не кусок «**»/«~~».
  if (d.length === 1 && (prev === d || next === d)) return false;
  return true;
}

function canClose(s: string, i: number, d: string): boolean {
  if (!s.startsWith(d, i)) return false;
  const prev = s[i - 1];
  const next = s[i + d.length];
  if (isSpace(prev) || isWordChar(next)) return false;
  if (d.length === 1 && (prev === d || next === d)) return false;
  return true;
}

/** Закрывающий разделитель для открытого в from (контент начинается с from); код и ссылки пропускаем. */
function findClose(s: string, from: number, d: string): number {
  let j = from + 1; // хотя бы один символ внутри
  while (j < s.length) {
    const ch = s[j];
    if (ch === "`") {
      const n = backticks(s, j);
      const end = codeEnd(s, j + n, n);
      j = end < 0 ? j + n : end + n;
      continue;
    }
    if (urlAt(s, j)) {
      j = Math.max(urlEnd(s, j), j + 1);
      continue;
    }
    if (canClose(s, j, d)) return j;
    j++;
  }
  return -1;
}

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.t === "text") last.text += text;
  else out.push({ t: "text", text });
}

/** Строчная разметка одной строки. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plain = 0;
  const flush = (to: number) => {
    pushText(out, s.slice(plain, to));
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === "`") {
      const n = backticks(s, i);
      const end = codeEnd(s, i + n, n);
      if (end > i + n) {
        flush(i);
        let code = s.slice(i + n, end);
        // «`` `x` ``»: пробелы вокруг — чтобы написать кавычку внутри.
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push({ t: "code", text: code });
        i = plain = end + n;
      } else {
        i += n;
      }
      continue;
    }
    if (urlAt(s, i)) {
      i = Math.max(urlEnd(s, i), i + 1);
      continue;
    }
    let matched = false;
    for (const [d, mark] of DELIMS) {
      if (!canOpen(s, i, d)) continue;
      const close = findClose(s, i + d.length, d);
      if (close < 0) continue;
      flush(i);
      out.push({ t: mark, children: parseInline(s.slice(i + d.length, close)) });
      i = plain = close + d.length;
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  flush(s.length);
  return out;
}

function quoteLine(line: string): string | null {
  if (line === ">") return "";
  return line.startsWith("> ") ? line.slice(2) : null;
}

function listLine(line: string): { ordered: boolean; n: number; depth: number; text: string } | null {
  const b = BULLET_RE.exec(line);
  if (b) return { ordered: false, n: 0, depth: Math.min(Math.floor(b[1].length / 2), 4), text: b[2] };
  const o = ORDERED_RE.exec(line);
  if (o) return { ordered: true, n: Number(o[2]), depth: Math.min(Math.floor(o[1].length / 2), 4), text: o[3] };
  return null;
}

/** Абзац: строки через «\n», пустые строки по краям убраны (отступ дают сами блоки). */
function paragraph(lines: string[]): Block | null {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  if (a === b) return null;
  const children: Inline[] = [];
  lines.slice(a, b).forEach((line, k) => {
    if (k) pushText(children, "\n");
    for (const part of parseInline(line)) {
      if (part.t === "text") pushText(children, part.text);
      else children.push(part);
    }
  });
  return { t: "para", children };
}

export function parseBlocks(text: string, options: BlockOptions = {}): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    const p = paragraph(para);
    if (p) blocks.push(p);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith(FENCE)) {
      const rest = line.slice(3);
      // «```код```» в одну строку.
      const inlineClose = rest.length > 3 ? rest.lastIndexOf(FENCE) : -1;
      if (inlineClose > 0 && inlineClose === rest.length - 3) {
        endPara();
        blocks.push({ t: "code", lang: "", text: rest.slice(0, inlineClose) });
        i++;
        continue;
      }
      const lang = LANG_RE.test(rest.trim()) ? rest.trim().toLowerCase() : "";
      const code: string[] = lang || !rest.trim() ? [] : [rest];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const l = lines[j];
        const at = l.trimEnd().endsWith(FENCE) ? l.trimEnd().length - 3 : -1;
        if (at >= 0) {
          if (at > 0) code.push(l.slice(0, at));
          closed = true;
          break;
        }
        code.push(l);
      }
      // Незакрытый блок — до конца сообщения, как в Markdown.
      endPara();
      blocks.push({ t: "code", lang, text: code.join("\n") });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    if (quoteLine(line) !== null) {
      const inner: string[] = [];
      while (i < lines.length && quoteLine(lines[i]) !== null) inner.push(quoteLine(lines[i++])!);
      endPara();
      blocks.push({ t: "quote", children: parseBlocks(inner.join("\n"), options) });
      continue;
    }

    if (options.headings) {
      const h = HEADING_RE.exec(line);
      if (h) {
        endPara();
        blocks.push({ t: "heading", level: h[1].length as 1 | 2 | 3, children: parseInline(h[2]) });
        i++;
        continue;
      }
      if (RULE_RE.test(line)) {
        endPara();
        blocks.push({ t: "rule" });
        i++;
        continue;
      }
    }

    const item = listLine(line);
    if (item) {
      endPara();
      const items: ListItem[] = [];
      let next: ReturnType<typeof listLine> = item;
      while (next && next.ordered === item.ordered) {
        items.push({ n: next.n, depth: next.depth, children: parseInline(next.text) });
        i++;
        next = i < lines.length ? listLine(lines[i]) : null;
      }
      blocks.push({ t: "list", ordered: item.ordered, items });
      continue;
    }

    para.push(line);
    i++;
  }
  endPara();
  return blocks;
}

/** Есть ли в тексте разметка (без неё — рисуем как раньше, просто текстом). */
export function hasMarkup(text: string): boolean {
  return /[*_~`]|^> |^>$|^ *[-*•] |^ *\d{1,4}[.)] /m.test(text);
}

function inlinePlain(parts: Inline[]): string {
  return parts.map((p) => (p.t === "text" || p.t === "code" ? p.text : inlinePlain(p.children))).join("");
}

function blocksPlain(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.t === "para") out.push(inlinePlain(b.children));
    else if (b.t === "code") out.push(b.text);
    else if (b.t === "quote") out.push(...blocksPlain(b.children));
    else if (b.t === "heading") out.push(inlinePlain(b.children));
    else if (b.t === "list") for (const item of b.items) out.push(inlinePlain(item.children));
  }
  return out;
}

/** Текст без разметки — для превью, уведомлений и поиска. */
export function stripMarkup(text: string): string {
  if (!hasMarkup(text)) return text;
  return blocksPlain(parseBlocks(text)).join("\n");
}

/** Текст без разметки в одну строку — для списка чатов и цитат. */
export function plainPreview(text: string): string {
  return stripMarkup(text).replace(/\s*\n\s*/g, " ").trim();
}

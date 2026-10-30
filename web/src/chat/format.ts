/**
 * Кнопки и сочетания клавиш разметки в поле ввода: оборачивают выделение (или вставляют пару
 * знаков с курсором между ними), повторное нажатие снимает разметку. Чистые функции — поле само
 * применяет результат.
 */

export type FormatKind = "bold" | "italic" | "strike" | "code" | "codeblock" | "quote" | "bullet" | "numbered";

export interface Edit {
  value: string;
  start: number;
  end: number;
}

const WRAP: Partial<Record<FormatKind, string>> = { bold: "**", italic: "_", strike: "~~", code: "`" };

function wrapInline(value: string, start: number, end: number, mark: string): Edit {
  // Уже обёрнуто — снимаем (выделен текст внутри знаков или вместе с ними).
  if (value.slice(start - mark.length, start) === mark && value.slice(end, end + mark.length) === mark) {
    return {
      value: value.slice(0, start - mark.length) + value.slice(start, end) + value.slice(end + mark.length),
      start: start - mark.length,
      end: end - mark.length,
    };
  }
  const sel = value.slice(start, end);
  if (sel.length >= mark.length * 2 + 1 && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(mark.length, -mark.length);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  if (!sel) {
    return { value: value.slice(0, start) + mark + mark + value.slice(end), start: start + mark.length, end: start + mark.length };
  }
  // Знаки прижимаем к тексту: «** текст **» не распознаётся. Разметка не переходит через строку.
  const parts = sel.split("\n").map((line) => /^(\s*)(.*?)(\s*)$/.exec(line)!);
  const out = parts.map((m) => (m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : m[0])).join("\n");
  const next = value.slice(0, start) + out + value.slice(end);
  // Одна строка — выделенным остаётся сам текст: повторное нажатие снимет разметку.
  if (parts.length === 1 && parts[0][2]) {
    const at = start + parts[0][1].length + mark.length;
    return { value: next, start: at, end: at + parts[0][2].length };
  }
  return { value: next, start, end: start + out.length };
}

/** Границы целых строк, задетых выделением. */
function lineRange(value: string, start: number, end: number): [number, number] {
  const a = value.lastIndexOf("\n", start - 1) + 1;
  // Выделение до начала следующей строки её не захватывает.
  const e = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nl = value.indexOf("\n", e);
  return [a, nl < 0 ? value.length : nl];
}

const PREFIX_RE: Record<"quote" | "bullet" | "numbered", RegExp> = {
  quote: /^> ?/,
  bullet: /^ *[-*•] +/,
  numbered: /^ *\d{1,4}[.)] +/,
};

function prefixLines(value: string, start: number, end: number, kind: "quote" | "bullet" | "numbered"): Edit {
  const [a, b] = lineRange(value, start, end);
  const lines = value.slice(a, b).split("\n");
  const re = PREFIX_RE[kind];
  const filled = lines.filter((l) => l.trim());
  const all = filled.length > 0 && filled.every((l) => re.test(l));
  let n = 0;
  const out = lines
    .map((line) => {
      if (all) return line.replace(re, "");
      if (!line.trim() && lines.length > 1) return line;
      // Другой вид списка или цитата — заменяем, а не наслаиваем.
      const bare = kind === "quote" ? line : line.replace(PREFIX_RE.bullet, "").replace(PREFIX_RE.numbered, "");
      const prefix = kind === "quote" ? "> " : kind === "bullet" ? "- " : `${++n}. `;
      return prefix + bare;
    })
    .join("\n");
  const next = value.slice(0, a) + out + value.slice(b);
  // Одна пустая строка — курсор после маркера; иначе выделяем всё изменённое.
  if (lines.length === 1 && !lines[0].trim()) return { value: next, start: a + out.length, end: a + out.length };
  return { value: next, start: a, end: a + out.length };
}

function codeBlock(value: string, start: number, end: number): Edit {
  const sel = value.slice(start, end);
  const before = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const after = end < value.length && value[end] !== "\n" ? "\n" : "";
  const open = `${before}\`\`\`\n`;
  const out = `${open}${sel}\n\`\`\`${after}`;
  const caret = start + open.length;
  return { value: value.slice(0, start) + out + value.slice(end), start: caret, end: caret + sel.length };
}

export function applyFormat(value: string, start: number, end: number, kind: FormatKind): Edit {
  const mark = WRAP[kind];
  if (mark) return wrapInline(value, start, end, mark);
  if (kind === "codeblock") return codeBlock(value, start, end);
  return prefixLines(value, start, end, kind as "quote" | "bullet" | "numbered");
}

/** «```код```» в одну строку блок не открывает. */
function closesOnSameLine(line: string): boolean {
  const rest = line.slice(3);
  return rest.length > 3 && rest.trimEnd().endsWith("```");
}

/** Курсор внутри незакрытого ```: Enter тогда переносит строку, а не отправляет. */
export function insideCodeFence(value: string, caret: number): boolean {
  const lines = value.slice(0, caret).split("\n");
  const current = lines.pop() ?? "";
  let open = false;
  for (const line of lines) {
    if (!open) open = line.startsWith("```") && !closesOnSameLine(line);
    else if (line.trimEnd().endsWith("```")) open = false;
  }
  if (open) return !current.trimEnd().endsWith("```");
  return current.startsWith("```") && !closesOnSameLine(current);
}

/**
 * Перенос строки в списке или цитате: продолжить маркер («- », «2. », «> ») на новой строке;
 * пустой пункт — убрать маркер и выйти из списка. null — обычный перенос.
 */
export function continueList(value: string, start: number, end: number): Edit | null {
  if (start !== end) return null;
  const a = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", start);
  const line = value.slice(a, start);
  const m = /^( *)([-*•]|\d{1,4}[.)]|>)( +)/.exec(line);
  if (!m) return null;
  const marker = m[0];
  if (!line.slice(marker.length).trim() && !value.slice(start, nl < 0 ? value.length : nl).trim()) {
    return { value: value.slice(0, a) + value.slice(start), start: a, end: a };
  }
  const num = /^\d+/.exec(m[2]);
  const nextMarker = num ? `${m[1]}${Number(num[0]) + 1}${m[2].slice(num[0].length)} ` : `${m[1]}${m[2]} `;
  const insert = `\n${nextMarker}`;
  return { value: value.slice(0, start) + insert + value.slice(end), start: start + insert.length, end: start + insert.length };
}

/** Сочетание клавиш → разметка (по физическим клавишам, чтобы работало в русской раскладке). */
export function formatForKey(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): FormatKind | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  if (!e.shiftKey && !e.altKey) {
    if (e.code === "KeyB") return "bold";
    if (e.code === "KeyI") return "italic";
    if (e.code === "KeyE") return "code";
    return null;
  }
  if (e.shiftKey && e.altKey) return e.code === "KeyC" ? "codeblock" : null;
  if (e.shiftKey) {
    if (e.code === "KeyX") return "strike";
    if (e.code === "KeyC") return "code";
    if (e.code === "Digit9") return "quote";
    if (e.code === "Digit8") return "bullet";
    if (e.code === "Digit7") return "numbered";
  }
  return null;
}

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+";

/** Подписи кнопок панели: название и сочетание. */
export const FORMAT_HINTS: Record<FormatKind, string> = {
  bold: `Жирный (${MOD}B)`,
  italic: `Курсив (${MOD}I)`,
  strike: `Зачёркнутый (${MOD}⇧X)`,
  code: `Код (${MOD}E)`,
  codeblock: `Блок кода (${MOD}⌥⇧C)`,
  quote: `Цитата (${MOD}⇧9)`,
  bullet: `Список (${MOD}⇧8)`,
  numbered: `Нумерованный список (${MOD}⇧7)`,
};

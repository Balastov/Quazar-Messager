/**
 * Что изменилось между двумя текстами — для истории правок заметок и сообщений.
 * lineDiff — по строкам (заметки), wordDiff — по словам (короткие сообщения). Обычный LCS:
 * тексты небольшие, а для очень длинных — грубый ответ «всё удалено, всё добавлено».
 */

export interface DiffPart {
  kind: "same" | "add" | "del";
  text: string;
}

/** Больше — не сравниваем по частям (LCS — квадрат по памяти). */
const MAX_CELLS = 4_000_000;

function diff(a: string[], b: string[]): DiffPart[] {
  // Общие начало и конец — без таблицы.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ kind: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ kind: "same" as const, text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let middle: DiffPart[];
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) {
    middle = [...x.map((text) => ({ kind: "del" as const, text })), ...y.map((text) => ({ kind: "add" as const, text }))];
  } else {
    // lcs[i][j] — длина общей части x[i:] и y[j:].
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push({ kind: "same", text: x[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        middle.push({ kind: "del", text: x[i++] });
      } else {
        middle.push({ kind: "add", text: y[j++] });
      }
    }
    while (i < x.length) middle.push({ kind: "del", text: x[i++] });
    while (j < y.length) middle.push({ kind: "add", text: y[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** По строкам: каждая часть — одна строка без «\n». */
export function lineDiff(before: string, after: string): DiffPart[] {
  return diff(before.split("\n"), after.split("\n"));
}

/** По словам (пробелы — отдельные части), соседние части одного вида склеены. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const tokens = (s: string) => s.split(/(\s+)/).filter(Boolean);
  const out: DiffPart[] = [];
  for (const part of diff(tokens(before), tokens(after))) {
    const last = out[out.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/** Сколько строк добавили и убрали — подпись в списке версий. */
export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.kind === "add") added++;
    else if (p.kind === "del") removed++;
  }
  return { added, removed };
}

// Поиск по тексту сообщений: все слова запроса, без учёта регистра и «ё».

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

export function queryWords(query: string): string[] {
  return norm(query).split(/\s+/).filter((w) => w.length > 0);
}

export function matches(text: string, words: string[]): boolean {
  if (!words.length) return false;
  const t = norm(text);
  return words.every((w) => t.includes(w));
}

/** Кусок текста вокруг первого совпадения, разбитый на обычные и найденные части. */
export function snippet(text: string, words: string[], radius = 40): { text: string; hit: boolean }[] {
  const flat = text.replace(/\s+/g, " ");
  const n = norm(flat);
  const first = Math.min(...words.map((w) => n.indexOf(w)).filter((i) => i >= 0));
  const start = Number.isFinite(first) ? Math.max(0, first - radius) : 0;
  const end = Math.min(flat.length, (Number.isFinite(first) ? first : 0) + radius * 3);
  const piece = (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
  const np = norm(piece);
  const marks = new Array<boolean>(piece.length).fill(false);
  for (const w of words) {
    let i = np.indexOf(w);
    while (i >= 0) {
      for (let j = i; j < i + w.length; j++) marks[j] = true;
      i = np.indexOf(w, i + w.length);
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < piece.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += piece[i];
    else parts.push({ text: piece[i], hit: marks[i] });
  }
  return parts;
}

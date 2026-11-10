import type { PremiumState } from "../../api/types";

export function premiumDate(value: string): string {
  // «10 декабря 2026» — без «г.», как в сообщениях news_bot.
  return new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }).replace(/\s*г\.$/, "");
}

/** Подпись состояния: «Пробный Premium до» + дата (дата — отдельно, её выделяем зелёным). */
export function premiumStatus(state: PremiumState | null | undefined): { text: string; until: string | null } {
  if (!state?.active) return { text: "Premium не подключён", until: null };
  if (state.forever) return { text: "Бессрочный Premium", until: null };
  const until = state.until ? premiumDate(state.until) : null;
  if (state.kind === "trial") return { text: "Пробный Premium до", until };
  if (state.kind === "purchase") return { text: "Premium куплен до", until };
  return { text: "Premium до", until };
}

/** «Звезда / Звезды / Звёзд» по числу. */
export function starsWord(n: number): string {
  const last = n % 10, tens = n % 100;
  if (last === 1 && tens !== 11) return "Звезда";
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return "Звезды";
  return "Звёзд";
}

/** «1 своя Звезда», «2 своих Звезды», «5 своих Звёзд». */
export function ownStars(n: number): string {
  const word = starsWord(n);
  return `${n} ${word === "Звезда" ? "своя" : "своих"} ${word}`;
}

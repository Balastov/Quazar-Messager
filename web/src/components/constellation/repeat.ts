// Повтор брони — как в календаре. Правило то же, что на сервере (backend/app/core/recurrence.py),
// подпись совпадает с recurrence.describe.
import type { RepeatRule } from "../../api/stars";

/** День недели: 0 — понедельник … 6 — воскресенье (как в Python). */
export function weekdayOf(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PLURAL_DAT = ["понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям"];
const ACC = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
const GENDER = ["m", "m", "f", "m", "f", "f", "n"] as const;
const ORDINALS = {
  m: ["первый", "второй", "третий", "четвёртый", "пятый", "последний"],
  f: ["первую", "вторую", "третью", "четвёртую", "пятую", "последнюю"],
  n: ["первое", "второе", "третье", "четвёртое", "пятое", "последнее"],
};

export function plural(n: number, one: string, few: string, many: string): string {
  if (n % 10 === 1 && n % 100 !== 11) return one;
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return few;
  return many;
}

function join(words: string[]): string {
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`;
}

/** Какой по счёту такой день недели в месяце: 1…5. */
export function nthInMonth(d: Date): number {
  return Math.floor((d.getDate() - 1) / 7) + 1;
}

/** Последний ли это такой день недели в месяце. */
export function isLastInMonth(d: Date): boolean {
  const next = new Date(d);
  next.setDate(d.getDate() + 7);
  return next.getMonth() !== d.getMonth();
}

function ordinalWeekday(d: Date, last: boolean): string {
  const weekday = weekdayOf(d);
  const ordinal = ORDINALS[GENDER[weekday]][last ? 5 : nthInMonth(d) - 1];
  return `${ordinal.startsWith("втор") ? "во" : "в"} ${ordinal} ${ACC[weekday]}`;
}

function dmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** «по вторникам и четвергам», «каждый месяц, во второй вторник, до 31.12.2026». first — день встречи. */
export function describeRepeat(rule: RepeatRule, first: Date): string {
  const interval = rule.interval ?? 1;
  let text: string;
  if (rule.freq === "daily") {
    text = interval === 1 ? "каждый день" : `раз в ${interval} ${plural(interval, "день", "дня", "дней")}`;
  } else if (rule.freq === "weekly") {
    const days = rule.weekdays?.length ? rule.weekdays : [weekdayOf(first)];
    const on =
      days.join() === "0,1,2,3,4" ? "по будням" : days.length === 7 ? "каждый день" : `по ${join(days.map((d) => PLURAL_DAT[d]))}`;
    text = interval === 1 ? on : `раз в ${interval} ${plural(interval, "неделю", "недели", "недель")}, ${on}`;
  } else {
    const every = interval === 1 ? "каждый месяц" : `раз в ${interval} ${plural(interval, "месяц", "месяца", "месяцев")}`;
    const mode = rule.monthly ?? "day";
    text = mode === "day" ? `${every}, ${first.getDate()}-го числа` : `${every}, ${ordinalWeekday(first, mode === "last_weekday")}`;
  }
  if (rule.until) text += `, до ${dmy(rule.until)}`;
  else if (rule.count) text += `, ${rule.count} ${plural(rule.count, "раз", "раза", "раз")}`;
  return text;
}

export type RepeatPreset = "none" | "daily" | "weekdays" | "weekly" | "monthly_day" | "monthly_weekday" | "monthly_last" | "custom";

/** Готовые варианты для выбранного дня — как в меню «Повторять» календаря. */
export function repeatPresets(first: Date): { value: RepeatPreset; label: string }[] {
  const weekday = weekdayOf(first);
  const list: { value: RepeatPreset; label: string }[] = [
    { value: "none", label: "Не повторять" },
    { value: "daily", label: "Каждый день" },
    { value: "weekdays", label: "По будням (пн–пт)" },
    { value: "weekly", label: `Каждую неделю, по ${PLURAL_DAT[weekday]}` },
    { value: "monthly_day", label: `Каждый месяц, ${first.getDate()}-го числа` },
  ];
  if (nthInMonth(first) <= 4) list.push({ value: "monthly_weekday", label: `Каждый месяц, ${ordinalWeekday(first, false)}` });
  if (isLastInMonth(first)) list.push({ value: "monthly_last", label: `Каждый месяц, ${ordinalWeekday(first, true)}` });
  list.push({ value: "custom", label: "Настроить…" });
  return list;
}

/** Правило готового варианта (без окончания); null — не повторять, custom собирается отдельно. */
export function presetRule(preset: RepeatPreset, first: Date): RepeatRule | null {
  switch (preset) {
    case "daily":
      return { freq: "daily", interval: 1 };
    case "weekdays":
      return { freq: "weekly", interval: 1, weekdays: [0, 1, 2, 3, 4] };
    case "weekly":
      return { freq: "weekly", interval: 1, weekdays: [weekdayOf(first)] };
    case "monthly_day":
      return { freq: "monthly", interval: 1, monthly: "day" };
    case "monthly_weekday":
      return { freq: "monthly", interval: 1, monthly: "weekday" };
    case "monthly_last":
      return { freq: "monthly", interval: 1, monthly: "last_weekday" };
    default:
      return null;
  }
}

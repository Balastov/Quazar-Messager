/** Исчезающие сообщения: варианты срока (те же — на сервере, app/schemas/chat.py). */
export const TTL_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Выключено" },
  { value: 3600, label: "1 час" },
  { value: 86400, label: "1 день" },
  { value: 604800, label: "1 неделя" },
];

export function ttlLabel(seconds: number | null | undefined): string {
  return TTL_OPTIONS.find((o) => o.value === (seconds ?? null))?.label ?? `${seconds} с`;
}

/** «через 23 мин», «через 5 ч», «через 3 дн» — сколько осталось до исчезновения. */
export function timeLeft(until: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  if (sec < 60) return "меньше минуты";
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  if (sec < 86400) return `${Math.round(sec / 3600)} ч`;
  return `${Math.round(sec / 86400)} дн`;
}

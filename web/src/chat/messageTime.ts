const pad = (n: number) => String(n).padStart(2, "0");

/** Время в пузыре сообщения: «14:05»; с датой — «20.11 14:05», для прошлых лет — «20.11.2025 14:05». */
export function messageTime(timestamp: string, withDate: boolean, now = new Date()): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (!withDate) return time;
  const day = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${day}.${date.getFullYear()} ${time}`;
}

/** Подсказка при наведении: «20 ноября 2026, 14:05». */
export function messageTimeTitle(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Calendar days on this device, rather than rolling 24-hour intervals. */
export function listTimestamp(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const time = () => date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date >= today && date < tomorrow) return time();
  if (date >= yesterday && date < today) return `вчера ${time()}`;
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

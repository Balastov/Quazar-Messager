export interface PresenceStatus {
  online: boolean;
  /** ISO-время, когда был(а) в сети в последний раз (если не в сети). */
  lastSeen: string | null;
}

const time = (d: Date) => d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });

/** «в сети», «был(а) 5 мин назад», «был(а) вчера в 21:40»… null — статус неизвестен. */
export function presenceText(status: PresenceStatus | undefined, now = new Date()): string | null {
  if (!status) return null;
  if (status.online) return "в сети";
  if (!status.lastSeen) return "был(а) давно";
  const seen = new Date(status.lastSeen);
  const minutes = Math.floor((now.getTime() - seen.getTime()) / 60_000);
  if (minutes < 1) return "был(а) только что";
  if (minutes < 60) return `был(а) ${minutes} мин назад`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (seen >= startOfToday) return `был(а) сегодня в ${time(seen)}`;
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  if (seen >= startOfYesterday) return `был(а) вчера в ${time(seen)}`;
  const sameYear = seen.getFullYear() === now.getFullYear();
  const date = seen.toLocaleDateString("ru", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `был(а) ${date}`;
}

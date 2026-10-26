/** Человеческие строки журнала Звезды (действия — backend/app/core/star_audit.py). */
import type { AuditEntry } from "../../api/stars";
import { ROLE_LABEL } from "./rules";

const TIMEOUT_LABEL: Record<number, string> = { 5: "5 минут", 60: "1 час", 1440: "1 день", 10080: "1 неделю" };

export function auditText(e: AuditEntry): string {
  const who = e.actor?.username ?? "Кто-то";
  const whom = e.target?.username ?? "участника";
  const d = e.details as Record<string, unknown>;
  const channel = typeof d.name === "string" ? `«${d.name}»` : "";
  switch (e.action) {
    case "kick":
      return `${who} выгнал(а) ${whom}`;
    case "ban":
      return `${who} заблокировал(а) ${whom}`;
    case "unban":
      return `${who} разблокировал(а) ${whom}`;
    case "role":
      return `${who} сменил(а) роль ${whom}: ${ROLE_LABEL[d.before as keyof typeof ROLE_LABEL] ?? d.before} → ${ROLE_LABEL[d.after as keyof typeof ROLE_LABEL] ?? d.after}`;
    case "timeout":
      return d.minutes
        ? `${who} дал(а) ${whom} тайм-аут на ${TIMEOUT_LABEL[d.minutes as number] ?? `${d.minutes} мин`}`
        : `${who} снял(а) тайм-аут с ${whom}`;
    case "message_delete":
      return `${who} удалил(а) сообщение ${whom}${d.text ? `: «${String(d.text).slice(0, 80)}»` : ""}`;
    case "channel_create":
      return `${who} создал(а) канал ${channel}`;
    case "channel_update":
      return `${who} изменил(а) канал ${channel}`;
    case "channel_delete":
      return `${who} удалил(а) канал ${channel}`;
    case "permissions":
      return `${who} изменил(а) права ролей`;
    case "settings":
      return `${who} изменил(а) правила и настройки сообщества`;
    case "tag":
      if (d.op === "create") return `${who} создал(а) роль «${d.name}»`;
      if (d.op === "delete") return `${who} удалил(а) роль «${d.name}»`;
      return d.op === "give" ? `${who} выдал(а) ${whom} роль «${d.name}»` : `${who} снял(а) с ${whom} роль «${d.name}»`;
    case "transfer":
      return `${who} передал(а) Звезду ${whom}`;
    default:
      return `${who}: ${e.action}`;
  }
}

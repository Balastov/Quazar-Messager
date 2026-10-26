export type PresenceKind = "online" | "away" | "offline";

const time = (d: Date) => d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
export type ManualKind = "meeting" | "dnd";

/** Ручной статус: «на встрече» / «не беспокоить» до until (null — пока не снимут). */
export interface ManualStatus {
  kind: ManualKind;
  until: string | null;
}

/** Свой статус: значок из набора, текст, «до» (null — пока не снимут). Только подпись. */
export interface CustomStatus {
  icon: string | null;
  text: string;
  until: string | null;
}

export interface PresenceStatus {
  /** online — работает с Quazar сейчас; away — отошёл(ла); offline — нет соединения. */
  status: PresenceKind;
  /** Есть соединение (в сети или отошёл). */
  online: boolean;
  /** С какого момента отошёл(ла) (ISO). */
  awaySince: string | null;
  /** Когда был(а) в сети в последний раз (ISO), если не в сети. */
  lastSeen: string | null;
  manual: ManualStatus | null;
  custom?: CustomStatus | null;
}

/** Событие сервера → статус. Старый сервер не присылал status — выводим из online. */
export function statusFromEvent(e: {
  status?: PresenceKind;
  online: boolean;
  away_since?: string | null;
  last_seen: string | null;
  manual?: ManualStatus | null;
  custom?: CustomStatus | null;
}): PresenceStatus {
  const status = e.status ?? (e.online ? "online" : "offline");
  return {
    status,
    online: status !== "offline",
    awaySince: e.away_since ?? null,
    lastSeen: e.last_seen,
    manual: e.manual ?? null,
    custom: e.custom ?? null,
  };
}

/** Свой статус, если он ещё действует. */
export function activeCustom(status: PresenceStatus | undefined, now = new Date()): CustomStatus | null {
  const custom = status?.custom;
  if (!custom || (!custom.icon && !custom.text)) return null;
  if (custom.until && new Date(custom.until).getTime() <= now.getTime()) return null;
  return custom;
}

/** Ручной статус, если он ещё действует (истёкший сервер не снимает — не показываем сами). */
export function activeManual(status: PresenceStatus | undefined, now = new Date()): ManualStatus | null {
  const manual = status?.manual;
  if (!manual) return null;
  if (manual.until && new Date(manual.until).getTime() <= now.getTime()) return null;
  return manual;
}

export const MANUAL_LABEL: Record<ManualKind, string> = {
  meeting: "на встрече",
  dnd: "не беспокоить",
};

/** «до 15:00» / «до 21 окт 09:00». */
export function untilText(until: string, now = new Date()): string {
  const at = new Date(until);
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `до ${time(at)}`;
  return `до ${at.toLocaleDateString("ru", { day: "numeric", month: "short" })} ${time(at)}`;
}

/** «5 мин назад», «сегодня в 14:05», «вчера в 21:40», «15 окт». */
function ago(iso: string, now: Date): string {
  const at = new Date(iso);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (at >= startOfToday) return `сегодня в ${time(at)}`;
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  if (at >= startOfYesterday) return `вчера в ${time(at)}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString("ru", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** «в сети», «отошёл(ла) 12 мин назад», «был(а) вчера в 21:40»… null — статус неизвестен. */
export function presenceText(status: PresenceStatus | undefined, now = new Date()): string | null {
  if (!status) return null;
  const manual = activeManual(status, now);
  if (manual) {
    return manual.until ? `${MANUAL_LABEL[manual.kind]} ${untilText(manual.until, now)}` : MANUAL_LABEL[manual.kind];
  }
  if (status.status === "online") return "в сети";
  if (status.status === "away") {
    return status.awaySince ? `отошёл(ла) ${ago(status.awaySince, now)}` : "отошёл(ла)";
  }
  if (!status.lastSeen) return "был(а) давно";
  return `был(а) ${ago(status.lastSeen, now)}`;
}

/** Цвет подписи: online — зелёный, away — жёлтый, busy — красный (ручной статус). */
export function presenceTone(status: PresenceStatus | undefined, now = new Date()): "online" | "away" | "busy" | null {
  if (activeManual(status, now)) return "busy";
  if (status?.status === "online") return "online";
  if (status?.status === "away") return "away";
  return null;
}

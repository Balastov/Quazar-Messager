/** Подписи к записи встречи в чате комнаты. */
import type { StarRecording } from "../../api/stars";

export const RETENTION_DAYS = 90;

const two = (n: number) => String(n).padStart(2, "0");

/** «1 ч 12 мин», «12 мин», «меньше минуты». */
export function durationText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "меньше минуты";
  const h = Math.floor(min / 60);
  return h ? `${h} ч${min % 60 ? ` ${min % 60} мин` : ""}` : `${min} мин`;
}

/** «21.11, 14:00–15:12 · 1 ч 12 мин» (в местном времени). */
export function recordingWhen(rec: Pick<StarRecording, "started_at" | "ended_at">): string {
  const start = new Date(rec.started_at);
  const day = `${two(start.getDate())}.${two(start.getMonth() + 1)}`;
  const time = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (!rec.ended_at) return `${day}, с ${time(start)}`;
  const end = new Date(rec.ended_at);
  return `${day}, ${time(start)}–${time(end)} · ${durationText(end.getTime() - start.getTime())}`;
}

/** До какого дня хранится: «до 19.02». */
export function keptUntil(startedAt: string): string {
  const until = new Date(new Date(startedAt).getTime() + RETENTION_DAYS * 86_400_000);
  return `до ${two(until.getDate())}.${two(until.getMonth() + 1)}`;
}

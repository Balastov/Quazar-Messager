import { useEffect, useState } from "react";
import type { StarDetail } from "../../api/stars";
import s from "./Constellation.module.css";

/** Сколько идёт Комната/Планета: «4:05», «1:02:03». */
export function formatActive(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** С какого момента в Комнате/на Планете кто-то есть без перерыва (null — пусто). */
export function activeSince(detail: StarDetail, channelId: string): string | null {
  return detail.voice?.[channelId]?.length ? (detail.voice_since?.[channelId] ?? null) : null;
}

/**
 * Время активности: от входа первого человека до выхода последнего. Тикает раз в секунду.
 * Часы клиента и сервера могут расходиться — отрицательное время показываем как 0:00.
 */
export function ActiveTime({ since, className }: { since: string | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return null;
  const start = Date.parse(since);
  const startedAt = new Date(start).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return (
    <span className={`${s.activeTime} ${className ?? ""}`} title={`Идёт с ${startedAt}`}>
      {formatActive(now - start)}
    </span>
  );
}

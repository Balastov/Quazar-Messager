// Рабочее время: тот же расчёт, что backend/app/core/work_hours.py.
import type { StarDetail, StarMember, WorkSchedule } from "../api/stars";

export const DEFAULT_SCHEDULE: WorkSchedule = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  tz: "Europe/Moscow",
};

export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** День недели (пн = 1) и «ЧЧ:ММ» в часовом поясе tz. */
export function localClock(tz: string, now: Date = new Date()): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: WEEKDAY_INDEX[get("weekday")] ?? 1, time: `${get("hour")}:${get("minute")}` };
}

export function isWorking(schedule: WorkSchedule, now: Date = new Date()): boolean {
  const { day, time } = localClock(schedule.tz, now);
  const { start, end, days } = schedule;
  if (start < end) return days.includes(day) && start <= time && time < end;
  // Через полночь: вечер — в рабочий день, утро — продолжение вчерашней смены.
  if (time >= start) return days.includes(day);
  const yesterday = day === 1 ? 7 : day - 1;
  return time < end && days.includes(yesterday);
}

/** Личный график, если задан, иначе общий график Звезды. */
export function effectiveSchedule(
  star: WorkSchedule | null | undefined,
  personal: WorkSchedule | null | undefined
): WorkSchedule {
  return personal ?? star ?? DEFAULT_SCHEDULE;
}

/** Рабочее время участника в Звезде; null — в Звезде оно выключено. */
export function memberWorkState(
  detail: Pick<StarDetail, "work_hours_enabled" | "work_hours">,
  member: Pick<StarMember, "work_schedule">,
  now: Date = new Date()
): { working: boolean; time: string } | null {
  if (!detail.work_hours_enabled) return null;
  const schedule = effectiveSchedule(detail.work_hours, member.work_schedule);
  return { working: isWorking(schedule, now), time: localClock(schedule.tz, now).time };
}

/** «Пн–Пт 09:00–18:00» */
export function scheduleLabel(schedule: WorkSchedule): string {
  const days = [...schedule.days].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
    runs.push(j - i >= 2 ? `${WEEKDAYS[days[i] - 1]}–${WEEKDAYS[days[j] - 1]}` : days.slice(i, j + 1).map((d) => WEEKDAYS[d - 1]).join(", "));
    i = j + 1;
  }
  return `${runs.join(", ")} ${schedule.start}–${schedule.end}`;
}

/** Часовой пояс браузера (для нового личного графика). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_SCHEDULE.tz;
  } catch {
    return DEFAULT_SCHEDULE.tz;
  }
}

/** Часовые пояса для выбора: браузер умеет перечислять, иначе — короткий список. */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.("timeZone");
    if (all?.length) return all;
  } catch {
    // ignore
  }
  return [
    "Europe/Kaliningrad",
    "Europe/Moscow",
    "Europe/Samara",
    "Asia/Yekaterinburg",
    "Asia/Omsk",
    "Asia/Novosibirsk",
    "Asia/Krasnoyarsk",
    "Asia/Irkutsk",
    "Asia/Yakutsk",
    "Asia/Vladivostok",
    "Asia/Magadan",
    "Asia/Kamchatka",
    "Europe/Berlin",
    "Europe/London",
    "UTC",
  ];
}

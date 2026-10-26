import { describe, expect, it } from "vitest";
import { isWorking, localClock, memberWorkState, scheduleLabel } from "../workhours";

const WEEKDAYS = { days: [1, 2, 3, 4, 5], start: "10:00", end: "19:00", tz: "Asia/Yekaterinburg" };

describe("work hours", () => {
  it("counts in the schedule's own time zone", () => {
    // Пн 26.10.2026 05:30 UTC = 10:30 в Екатеринбурге.
    expect(localClock("Asia/Yekaterinburg", new Date("2026-10-26T05:30:00Z"))).toEqual({ day: 1, time: "10:30" });
    expect(isWorking(WEEKDAYS, new Date("2026-10-26T05:30:00Z"))).toBe(true);
    expect(isWorking(WEEKDAYS, new Date("2026-10-26T04:30:00Z"))).toBe(false);
    expect(isWorking(WEEKDAYS, new Date("2026-10-31T06:00:00Z"))).toBe(false);
  });

  it("continues a night shift after midnight", () => {
    const night = { days: [5], start: "22:00", end: "06:00", tz: "UTC" };
    expect(isWorking(night, new Date("2026-10-30T23:00:00Z"))).toBe(true);
    expect(isWorking(night, new Date("2026-10-31T05:00:00Z"))).toBe(true);
    expect(isWorking(night, new Date("2026-10-30T05:00:00Z"))).toBe(false);
  });

  it("uses the personal schedule over the Star's and only when enabled", () => {
    const at = new Date("2026-10-26T05:30:00Z");
    const detail = { work_hours_enabled: true, work_hours: WEEKDAYS };
    expect(memberWorkState(detail, { work_schedule: null }, at)).toEqual({ working: true, time: "10:30" });
    const berlin = { days: [1], start: "09:00", end: "18:00", tz: "Europe/Berlin" };
    expect(memberWorkState(detail, { work_schedule: berlin }, at)).toEqual({ working: false, time: "06:30" });
    expect(memberWorkState({ ...detail, work_hours_enabled: false }, { work_schedule: null }, at)).toBeNull();
  });

  it("labels days compactly", () => {
    expect(scheduleLabel(WEEKDAYS)).toBe("Пн–Пт 10:00–19:00");
    expect(scheduleLabel({ ...WEEKDAYS, days: [1, 3, 6, 7] })).toBe("Пн, Ср, Сб, Вс 10:00–19:00");
  });
});

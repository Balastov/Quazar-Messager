import { useEffect, useMemo, useState } from "react";
import type { StarDetail, WorkSchedule } from "../../api/stars";
import { useStarsStore } from "../../store/stars";
import {
  browserTimeZone,
  DEFAULT_SCHEDULE,
  isWorking,
  localClock,
  scheduleLabel,
  timeZones,
  WEEKDAYS,
} from "../../chat/workhours";
import { apiError } from "./rules";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";
import w from "./Work.module.css";

/** Дни, часы и часовой пояс. */
export function ScheduleEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: WorkSchedule;
  onChange: (next: WorkSchedule) => void;
  disabled?: boolean;
}) {
  const zones = useMemo(() => {
    const all = timeZones();
    return all.includes(value.tz) ? all : [value.tz, ...all];
  }, [value.tz]);
  const toggleDay = (day: number) => {
    const days = value.days.includes(day) ? value.days.filter((d) => d !== day) : [...value.days, day];
    onChange({ ...value, days: days.sort((a, b) => a - b) });
  };
  return (
    <>
      <div className={s.label}>
        Рабочие дни
        <div className={w.days}>
          {WEEKDAYS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={value.days.includes(i + 1) ? `${w.day} ${w.dayOn}` : w.day}
              aria-pressed={value.days.includes(i + 1)}
              disabled={disabled}
              onClick={() => toggleDay(i + 1)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={w.times}>
        <label className={s.label}>
          С
          <input
            className={s.input}
            type="time"
            value={value.start}
            disabled={disabled}
            onChange={(e) => e.target.value && onChange({ ...value, start: e.target.value })}
          />
        </label>
        <label className={s.label}>
          До
          <input
            className={s.input}
            type="time"
            value={value.end}
            disabled={disabled}
            onChange={(e) => e.target.value && onChange({ ...value, end: e.target.value })}
          />
        </label>
      </div>
      {value.end < value.start && <p className={s.hint}>Смена через полночь: до {value.end} следующего дня.</p>}
      <label className={s.label}>
        Часовой пояс
        <select
          className={s.select}
          value={value.tz}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, tz: e.target.value })}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function scheduleProblem(schedule: WorkSchedule): string | null {
  if (!schedule.days.length) return "Выберите хотя бы один день";
  if (schedule.start === schedule.end) return "Начало и конец совпадают";
  return null;
}

/** Рабочее время Звезды: включить, общий график. Только владелец и админы. */
export function WorkHoursTab({ detail }: { detail: StarDetail }) {
  const setWorkHours = useStarsStore((st) => st.setWorkHours);
  const [enabled, setEnabled] = useState(detail.work_hours_enabled ?? false);
  const [schedule, setSchedule] = useState<WorkSchedule>(detail.work_hours ?? DEFAULT_SCHEDULE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const problem = enabled ? scheduleProblem(schedule) : null;

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await setWorkHours(enabled, enabled ? schedule : undefined);
      setDone(true);
    } catch (err) {
      setError(apiError(err, "Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={g.form}>
      <label className={g.check}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
        Учитывать рабочее время
      </label>
      <p className={s.hint}>
        В списке участников видно, у кого сейчас нерабочее время и сколько там времени. Вне своих часов
        человек не получает звуков и уведомлений о стуке и приглашениях из этой Звезды. Каждый может
        поставить себе свой график в настройках приложения — иначе действует общий.
      </p>
      {enabled && <ScheduleEditor value={schedule} onChange={setSchedule} disabled={busy} />}
      {enabled && !problem && (
        <p className={s.hint}>
          Общий график: {scheduleLabel(schedule)} ({schedule.tz}). Сейчас там {localClock(schedule.tz).time} —{" "}
          {isWorking(schedule) ? "рабочее время" : "нерабочее время"}.
        </p>
      )}
      {(problem || error) && <div className={s.error}>{problem ?? error}</div>}
      {done && <div className={s.ok}>Сохранено</div>}
      <button type="button" className={s.primary} disabled={busy || !!problem} onClick={() => void save()}>
        Сохранить
      </button>
    </div>
  );
}

/** Мой график для всех рабочих Звёзд (настройки приложения). */
export function MyWorkSchedule() {
  const mySchedule = useStarsStore((st) => st.mySchedule);
  const loadMySchedule = useStarsStore((st) => st.loadMySchedule);
  const setMySchedule = useStarsStore((st) => st.setMySchedule);
  const [own, setOwn] = useState(false);
  const [schedule, setSchedule] = useState<WorkSchedule>({ ...DEFAULT_SCHEDULE, tz: browserTimeZone() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (mySchedule === undefined) void loadMySchedule().catch(() => setError("Не удалось загрузить график"));
  }, [mySchedule, loadMySchedule]);

  useEffect(() => {
    if (mySchedule === undefined) return;
    setOwn(mySchedule !== null);
    if (mySchedule) setSchedule(mySchedule);
  }, [mySchedule]);

  const problem = own ? scheduleProblem(schedule) : null;

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await setMySchedule(own ? schedule : null);
      setDone(true);
    } catch (err) {
      setError(apiError(err, "Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={g.form}>
      <label className={g.check}>
        <input type="radio" name="my-work-schedule" checked={!own} onChange={() => setOwn(false)} disabled={busy} />
        Как в каждой Звезде (общий график, который задали владелец и админы)
      </label>
      <label className={g.check}>
        <input type="radio" name="my-work-schedule" checked={own} onChange={() => setOwn(true)} disabled={busy} />
        Свой график
      </label>
      {own && <ScheduleEditor value={schedule} onChange={setSchedule} disabled={busy} />}
      {(problem || error) && <div className={s.error}>{problem ?? error}</div>}
      {done && <div className={s.ok}>Сохранено</div>}
      <button
        type="button"
        className={s.primary}
        disabled={busy || !!problem || mySchedule === undefined}
        onClick={() => void save()}
      >
        Сохранить
      </button>
    </div>
  );
}

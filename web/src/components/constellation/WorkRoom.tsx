import { useCallback, useEffect, useState } from "react";
import { IconCross, IconPencil } from "../icons";
import { createPortal } from "react-dom";
import axios from "axios";
import {
  guestLinkUrl,
  starsApi,
  type BookingBusy,
  type CancelScope,
  type DoorSignKind,
  type GuestLink,
  type RepeatRule,
  type StarBooking,
  type StarChannel,
  type StarDetail,
} from "../../api/stars";
import { can, roomDoor } from "./rules";
import { formatWhen } from "../../chat/when";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import { bookingRange, currentBooking, DOOR_SIGNS, doorSign, hhmm, upcomingBookings, useBookings } from "./work";
import {
  describeRepeat,
  isLastInMonth,
  plural,
  presetRule,
  repeatPresets,
  weekdayOf,
  WEEKDAY_SHORT,
  type RepeatPreset,
} from "./repeat";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";
import w from "./Work.module.css";
import { displayName } from "../../utils/profile";

const SIGN_CLASS: Partial<Record<DoorSignKind, string>> = {
  dnd: w.signDnd,
  welcome: w.signWelcome,
  away: w.signAway,
};

const SIGN_DURATIONS: { label: string; minutes: number | null }[] = [
  { label: "Пока не сниму", minutes: null },
  { label: "30 минут", minutes: 30 },
  { label: "1 час", minutes: 60 },
  { label: "2 часа", minutes: 120 },
  { label: "До конца дня", minutes: -1 },
];

function untilFor(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes === -1) {
    const end = new Date();
    end.setHours(23, 59, 0, 0);
    return end.toISOString();
  }
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Табличка на двери (личный кабинет) или брони (остальные комнаты) — в рабочей Звезде. */
export default function WorkRoomExtras({ detail, channel }: { detail: StarDetail; channel: StarChannel }) {
  if (detail.kind !== "work" || channel.kind !== "planet" || channel.room_kind === "lobby") return null;
  return (
    <>
      {channel.access === "personal" ? (
        <DoorSignBlock detail={detail} channel={channel} />
      ) : (
        <RoomBookings detail={detail} channel={channel} />
      )}
      <GuestLinks detail={detail} channel={channel} />
    </>
  );
}

function DoorSignBlock({ detail, channel }: { detail: StarDetail; channel: StarChannel }) {
  const myId = useAuthStore((st) => st.user?.id);
  const setDoorSign = useStarsStore((st) => st.setDoorSign);
  const sign = doorSign(channel);
  const canEdit =
    channel.cabinet_owner_id === myId || detail.my_role === "owner" || detail.my_role === "admin";
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [minutes, setMinutes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const put = async (kind: DoorSignKind | null) => {
    if (kind === "custom" && !custom.trim()) {
      setError("Напишите, что будет на табличке");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setDoorSign(channel.id, {
        kind,
        text: kind === "custom" ? custom.trim() : null,
        until: kind ? untilFor(minutes) : null,
      });
      setOpen(false);
    } catch (err) {
      setError(apiError(err, "Не удалось повесить табличку"));
    } finally {
      setBusy(false);
    }
  };

  if (!sign && !canEdit) return null;
  return (
    <div className={w.bookings}>
      <div className={s.row}>
        {sign ? (
          <span className={`${w.doorSign} ${SIGN_CLASS[sign.kind] ?? ""}`}>
            {sign.icon} {sign.text}
            {channel.door_sign_until ? ` · до ${hhmm(channel.door_sign_until)}` : ""}
          </span>
        ) : (
          <span className={s.hint}>Табличка на двери не висит</span>
        )}
        {canEdit && (
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setOpen((o) => !o)}>
            {sign ? "Сменить" : "Повесить табличку"}
          </button>
        )}
        {canEdit && sign && (
          <button type="button" className={`${s.secondary} ${s.small}`} disabled={busy} onClick={() => void put(null)}>
            Снять
          </button>
        )}
      </div>
      {open && (
        <div className={g.form}>
          <label className={s.label}>
            На сколько
            <select
              className={s.select}
              value={minutes ?? ""}
              onChange={(e) => setMinutes(e.target.value === "" ? null : Number(e.target.value))}
            >
              {SIGN_DURATIONS.map((d) => (
                <option key={d.label} value={d.minutes ?? ""}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <div className={w.signPresets}>
            {(["dnd", "welcome", "away"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`${w.doorSign} ${SIGN_CLASS[kind] ?? ""}`}
                disabled={busy}
                onClick={() => void put(kind)}
              >
                {DOOR_SIGNS[kind].icon} {DOOR_SIGNS[kind].label}
              </button>
            ))}
          </div>
          <div className={s.row}>
            <input
              className={s.input}
              style={{ flex: 1, width: "auto" }}
              value={custom}
              maxLength={80}
              placeholder="Своя надпись: «Пишу отчёт до 16:00»"
              onChange={(e) => setCustom(e.target.value)}
            />
            <button type="button" className={`${s.primary} ${s.small}`} disabled={busy} onClick={() => void put("custom")}>
              Повесить
            </button>
          </div>
          <p className={s.hint}>
            «Не беспокоить» не запирает дверь: прежде чем постучаться, человек увидит табличку и
            подтвердит, что всё-таки нужно.
          </p>
        </div>
      )}
      {error && <div className={s.error}>{error}</div>}
    </div>
  );
}

function RoomBookings({ detail, channel }: { detail: StarDetail; channel: StarChannel }) {
  const myId = useAuthStore((st) => st.user?.id);
  const cancelBooking = useStarsStore((st) => st.cancelBooking);
  const { bookings, now } = useBookings(detail);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState<StarBooking | null>(null);
  const [editingBooking, setEditingBooking] = useState<StarBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = upcomingBookings(bookings, channel.id, now);
  const current = currentBooking(bookings, channel.id, now);
  const isAdmin = detail.my_role === "owner" || detail.my_role === "admin";
  const nameOf = (id: string | null) =>
    displayName(detail.members.find((m) => m.user.id === id)?.user) ?? "бывший участник";

  return (
    <div className={w.bookings}>
      <div className={s.row}>
        <span className={w.sectionTitle} style={{ flex: 1 }}>
          {current ? `Занято до ${hhmm(current.ends_at)}` : "Брони"}
        </span>
        <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setOpen(true)}>
          📅 Забронировать
        </button>
      </div>
      {list.length === 0 && <span className={s.hint}>На неделю вперёд свободно</span>}
      {list.length > 0 && <div className={w.bookingList}>{list.slice(0, 6).map((b) => {
        const mine = b.created_by === myId;
        const invited = myId ? b.attendees.includes(myId) : false;
        return (
          <div key={b.id} className={b.id === current?.id ? `${w.booking} ${w.bookingNow}` : w.booking}>
            <span className={w.bookingWhen}>{bookingRange(b)}</span>
            <span
              className={w.bookingTitle}
              title={[
                b.title,
                b.repeat ? `повтор: ${describeRepeat(b.repeat, new Date(b.starts_at))}` : "",
                `бронь: ${nameOf(b.created_by)}`,
              ].filter(Boolean).join(" · ")}
            >
              {b.repeat && <span className={w.repeatMark} aria-label="Повторяется">🔁 </span>}
              {b.title}
              {invited ? " · вас позвали" : ""}
            </span>
            {(mine || isAdmin) && (
              <>
                <button
                  type="button"
                  className={`${w.bookingIcon} ${w.bookingEdit}`}
                  aria-label={`Изменить бронь «${b.title}»`}
                  title="Изменить"
                  onClick={() => {
                    setError(null);
                    setEditingBooking(b);
                  }}
                >
                  <IconPencil size={16} />
                </button>
                <button
                  type="button"
                  className={`${w.bookingIcon} ${w.bookingCancel}`}
                  aria-label={`Отменить бронь «${b.title}»`}
                  title="Отменить"
                  onClick={() => {
                    setError(null);
                    if (b.series_id) {
                      setCancelling(b);
                      return;
                    }
                    if (!window.confirm(`Отменить бронь «${b.title}»?`)) return;
                    void cancelBooking(b).catch((err) => setError(apiError(err, "Не удалось отменить")));
                  }}
                >
                  <IconCross size={16} />
                </button>
              </>
            )}
          </div>
        );
      })}</div>}
      {error && <div className={s.error}>{error}</div>}
      {open && createPortal(<BookingDialog detail={detail} channel={channel} onClose={() => setOpen(false)} />, document.body)}
      {editingBooking &&
        createPortal(
          <BookingDialog
            key={editingBooking.id}
            detail={detail}
            channel={channel}
            editing={editingBooking}
            onClose={() => setEditingBooking(null)}
          />,
          document.body
        )}
      {cancelling &&
        createPortal(<CancelSeriesDialog booking={cancelling} onClose={() => setCancelling(null)} />, document.body)}
    </div>
  );
}

const CANCEL_SCOPES: { value: CancelScope; label: string }[] = [
  { value: "one", label: "Только эту встречу" },
  { value: "following", label: "Эту и следующие" },
  { value: "all", label: "Все встречи серии" },
];

/** Отмена встречи повторяющейся серии: одну, с этой и дальше или всю серию. */
export function CancelSeriesDialog({ booking, onClose }: { booking: StarBooking; onClose: () => void }) {
  const cancelBooking = useStarsStore((st) => st.cancelBooking);
  const [scope, setScope] = useState<CancelScope>("one");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelBooking(booking, scope);
      onClose();
    } catch (err) {
      setError(apiError(err, "Не удалось отменить"));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Отменить «${booking.title}»`} onClose={onClose}>
      <div className={g.form}>
        {booking.repeat && (
          <p className={s.hint}>
            🔁 {capitalize(describeRepeat(booking.repeat, new Date(booking.starts_at)))}. Эта встреча — {bookingRange(booking)}.
          </p>
        )}
        <div className={w.repeatEnd} role="radiogroup" aria-label="Что отменить">
          {CANCEL_SCOPES.map((option) => (
            <label key={option.value} className={g.check}>
              <input
                type="radio"
                name="cancel-scope"
                checked={scope === option.value}
                onChange={() => setScope(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
        <p className={s.hint}>Участникам придёт уведомление об отмене.</p>
        {error && <div className={s.error}>{error}</div>}
        <button type="button" className={s.danger} disabled={busy} onClick={() => void submit()}>
          Отменить
        </button>
      </div>
    </Dialog>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Ближайшие полчаса: 14:10 → 14:30. */
function nextSlot(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

/** Конец по умолчанию — через час, но в тот же день: бронь не переходит за полночь. */
function defaultEnd(start: Date): Date {
  const end = new Date(start.getTime() + 60 * 60_000);
  if (end.getDate() === start.getDate()) return end;
  const late = new Date(start);
  late.setHours(23, 59, 0, 0);
  return late;
}

type RepeatEnd = "never" | "until" | "count";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function busyDetail(err: unknown): BookingBusy | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 409) return null;
  const detail = err.response.data?.detail;
  return detail && typeof detail === "object" && Array.isArray(detail.busy) ? (detail as BookingBusy) : null;
}

/** Через сколько месяцев по умолчанию кончается серия «до даты». */
function monthsLater(d: Date, months: number): string {
  const next = new Date(d);
  next.setMonth(next.getMonth() + months);
  return localDate(next);
}

/** Бронь: новая или (editing) изменение существующей — у встречи серии с выбором, какие встречи менять. */
export function BookingDialog({
  detail,
  channel,
  onClose,
  editing,
}: {
  detail: StarDetail;
  channel: StarChannel;
  onClose: () => void;
  editing?: StarBooking;
}) {
  const myId = useAuthStore((st) => st.user?.id);
  const book = useStarsStore((st) => st.book);
  const updateBooking = useStarsStore((st) => st.updateBooking);
  const [start] = useState(() => (editing ? new Date(editing.starts_at) : nextSlot()));
  const [date, setDate] = useState(localDate(start));
  const [from, setFrom] = useState(localTime(start));
  const [to, setTo] = useState(localTime(editing ? new Date(editing.ends_at) : defaultEnd(start)));
  const [title, setTitle] = useState(editing?.title ?? "");
  const [attendees, setAttendees] = useState<Set<string>>(new Set(editing?.attendees ?? []));
  const [scope, setScope] = useState<CancelScope>("one");
  // У нескольких встреч серии меняется время, а день у каждой остаётся свой.
  const dayLocked = !!editing?.series_id && scope !== "one";
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState<RepeatPreset>("none");
  const [freq, setFreq] = useState<RepeatRule["freq"]>("weekly");
  const [every, setEvery] = useState(1);
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([weekdayOf(start)]));
  const [monthly, setMonthly] = useState<NonNullable<RepeatRule["monthly"]>>("day");
  const [ending, setEnding] = useState<RepeatEnd>("never");
  const [until, setUntil] = useState(monthsLater(start, 3));
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [busyDays, setBusyDays] = useState<BookingBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Позвать можно всех, кроме автора брони (он и так на встрече).
  const owner = editing ? editing.created_by : myId;
  const others = detail.members.filter(
    (m) =>
      m.user.id !== owner &&
      [m.user.username, displayName(m.user)].some((n) => n.toLowerCase().includes(query.trim().toLowerCase()))
  );
  const parsedFirst = new Date(`${date}T${from || "00:00"}`);
  const first = Number.isNaN(parsedFirst.getTime()) ? start : parsedFirst;
  const presets = repeatPresets(first);
  // Сменили день — вариант «во второй вторник» мог пропасть.
  const shownPreset = !editing && presets.some((p) => p.value === preset) ? preset : "none";

  const baseRule: RepeatRule | null =
    shownPreset === "custom"
      ? {
          freq,
          interval: every,
          ...(freq === "weekly" ? { weekdays: [...weekdays].sort((a, b) => a - b) } : {}),
          ...(freq === "monthly" ? { monthly: monthly === "last_weekday" && !isLastInMonth(first) ? "weekday" : monthly } : {}),
        }
      : presetRule(shownPreset, first);
  const rule: RepeatRule | null = baseRule && {
    ...baseRule,
    until: ending === "until" ? until : null,
    count: ending === "count" ? count : null,
  };

  const choosePreset = (value: RepeatPreset) => {
    if (value === "custom" && shownPreset !== "custom") {
      // «Настроить…» начинается с того, что было выбрано.
      const current = presetRule(shownPreset, first) ?? { freq: "weekly" as const, weekdays: [weekdayOf(first)] };
      setFreq(current.freq);
      setEvery(1);
      setWeekdays(new Set(current.weekdays ?? [weekdayOf(first)]));
      setMonthly(current.monthly ?? "day");
    }
    setPreset(value);
    setBusyDays(null);
  };

  const toggleWeekday = (day: number) =>
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) {
        if (next.size > 1) next.delete(day);
      } else next.add(day);
      return next;
    });

  const submit = async (skipBusy = false) => {
    const startsAt = new Date(`${date}T${from}`);
    const endsAt = new Date(`${date}T${to}`);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      setError("Укажите дату и время");
      return;
    }
    if (endsAt <= startsAt) {
      setError("Конец должен быть позже начала");
      return;
    }
    if (rule?.until && rule.until < date) {
      setError("Повтор заканчивается раньше первой встречи");
      return;
    }
    setBusy(true);
    setError(null);
    setBusyDays(null);
    if (editing) {
      try {
        await updateBooking(
          editing,
          {
            title: title.trim() || "Встреча",
            starts_at: startsAt.toISOString(),
            ends_at: endsAt.toISOString(),
            attendees: [...attendees],
          },
          editing.series_id ? scope : "one"
        );
        onClose();
      } catch (err) {
        const days = busyDetail(err);
        if (days) setBusyDays(days);
        else setError(apiError(err, "Не удалось сохранить"));
        setBusy(false);
      }
      return;
    }
    try {
      await book(channel.id, {
        title: title.trim() || "Встреча",
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        attendees: [...attendees],
        ...(rule
          ? { repeat: rule, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, skip_busy: skipBusy }
          : {}),
      });
      onClose();
    } catch (err) {
      const days = busyDetail(err);
      if (days) setBusyDays(days);
      else setError(apiError(err, "Не удалось забронировать"));
      setBusy(false);
    }
  };

  const unit = (one: string, few: string, many: string) => plural(every, one, few, many);

  return (
    <Dialog title={editing ? `Изменить бронь: ${channel.name}` : `Бронь: ${channel.name}`} onClose={onClose}>
      <form
        className={g.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={s.label}>
          Тема
          <input className={s.input} value={title} maxLength={100} autoFocus placeholder="Планёрка" onChange={(e) => setTitle(e.target.value)} />
        </label>
        {editing?.series_id && (
          <div className={s.label}>
            Какие встречи изменить
            <div className={w.repeatEnd} role="radiogroup" aria-label="Какие встречи изменить">
              {CANCEL_SCOPES.map((option) => (
                <label key={option.value} className={g.check}>
                  <input
                    type="radio"
                    name="edit-scope"
                    checked={scope === option.value}
                    onChange={() => {
                      setScope(option.value);
                      // День у нескольких встреч не меняется — вернуть день этой встречи.
                      if (option.value !== "one") setDate(localDate(start));
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
        )}
        <label className={s.label}>
          День
          <input
            className={s.input}
            type="date"
            value={date}
            min={localDate(new Date())}
            disabled={dayLocked}
            style={dayLocked ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
            onChange={(e) => setDate(e.target.value)}
          />
          {dayLocked && <span className={s.hint}>Каждая встреча останется в свой день — меняются время, тема и участники.</span>}
        </label>
        <div className={w.times}>
          <label className={s.label}>
            С
            <input className={s.input} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className={s.label}>
            До
            <input className={s.input} type="time" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {!editing && <label className={s.label}>
          Повторять
          <select
            className={s.select}
            value={shownPreset}
            data-testid="booking-repeat"
            onChange={(e) => choosePreset(e.target.value as RepeatPreset)}
          >
            {presets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>}
        {editing?.repeat && !dayLocked && (
          <p className={s.hint}>
            🔁 Встреча серии ({describeRepeat(editing.repeat, new Date(editing.starts_at))}). Повтор не меняется — чтобы
            поменять его, отмените серию и создайте заново.
          </p>
        )}
        {shownPreset === "custom" && (
          <div className={w.repeatBox}>
            <div className={w.repeatEvery}>
              Раз в
              <input
                className={s.input}
                type="number"
                min={1}
                max={30}
                value={every}
                aria-label="Интервал повтора"
                onChange={(e) => setEvery(Math.min(30, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
              />
              <select
                className={s.select}
                value={freq}
                aria-label="Единица повтора"
                onChange={(e) => setFreq(e.target.value as RepeatRule["freq"])}
              >
                <option value="daily">{unit("день", "дня", "дней")}</option>
                <option value="weekly">{unit("неделю", "недели", "недель")}</option>
                <option value="monthly">{unit("месяц", "месяца", "месяцев")}</option>
              </select>
            </div>
            {freq === "weekly" && (
              <div className={w.days} role="group" aria-label="Дни недели">
                {WEEKDAY_SHORT.map((label, day) => (
                  <button
                    key={label}
                    type="button"
                    className={weekdays.has(day) ? `${w.day} ${w.dayOn}` : w.day}
                    aria-pressed={weekdays.has(day)}
                    onClick={() => toggleWeekday(day)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {freq === "monthly" && (
              <select
                className={s.select}
                value={monthly === "last_weekday" && !isLastInMonth(first) ? "weekday" : monthly}
                aria-label="День месяца"
                onChange={(e) => setMonthly(e.target.value as NonNullable<RepeatRule["monthly"]>)}
              >
                <option value="day">{first.getDate()}-го числа</option>
                <option value="weekday">
                  {describeRepeat({ freq: "monthly", monthly: "weekday" }, first).replace("каждый месяц, ", "")}
                </option>
                {isLastInMonth(first) && (
                  <option value="last_weekday">
                    {describeRepeat({ freq: "monthly", monthly: "last_weekday" }, first).replace("каждый месяц, ", "")}
                  </option>
                )}
              </select>
            )}
          </div>
        )}
        {rule && (
          <div className={s.label}>
            Окончание
            <div className={w.repeatEnd} role="radiogroup" aria-label="Окончание повтора">
              <label className={g.check}>
                <input type="radio" name="repeat-end" checked={ending === "never"} onChange={() => setEnding("never")} />
                Никогда
              </label>
              <label className={g.check}>
                <input type="radio" name="repeat-end" checked={ending === "until"} onChange={() => setEnding("until")} />
                До
                <input
                  className={s.input}
                  type="date"
                  value={until}
                  min={date}
                  aria-label="Последний день серии"
                  onFocus={() => setEnding("until")}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </label>
              <label className={g.check}>
                <input type="radio" name="repeat-end" checked={ending === "count"} onChange={() => setEnding("count")} />
                После
                <input
                  className={s.input}
                  type="number"
                  min={2}
                  max={365}
                  value={count}
                  aria-label="Сколько встреч"
                  onFocus={() => setEnding("count")}
                  onChange={(e) => setCount(Math.min(365, Math.max(2, Math.round(Number(e.target.value)) || 2)))}
                />
                {plural(count, "встречи", "встреч", "встреч")}
              </label>
            </div>
            <span className={w.repeatSummary}>
              🔁 {capitalize(describeRepeat(rule, first))}, {from}–{to}
            </span>
          </div>
        )}
        <div className={s.label}>
          Позвать · {attendees.size}
          <input className={s.input} value={query} placeholder="Найти участника" onChange={(e) => setQuery(e.target.value)} />
          <div className={w.peopleList}>
            {others.map((m) => (
              <label key={m.user.id} className={g.check}>
                <input
                  type="checkbox"
                  checked={attendees.has(m.user.id)}
                  onChange={(e) =>
                    setAttendees((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.user.id);
                      else next.delete(m.user.id);
                      return next;
                    })
                  }
                />
                {displayName(m.user)}
              </label>
            ))}
          </div>
        </div>
        <p className={s.hint}>
          За 10 минут всем придёт напоминание, а на время встречи статус станет «на встрече» (кроме
          тех, кто сам поставил «не беспокоить»). До 8 часов, не дальше чем на 60 дней вперёд.
          {rule && " Повторяющиеся встречи бронируются на 60 дней вперёд, следующие — сами по мере приближения."}
        </p>
        {busyDays && (
          <div className={w.busyDays} role="alert">
            <strong>{busyDays.message}</strong>
            <ul>
              {busyDays.busy.map((b) => (
                <li key={b.starts_at}>
                  {bookingRange({ starts_at: b.starts_at, ends_at: b.ends_at } as StarBooking)} — «{b.title}»
                  {b.who ? ` (${b.who})` : ""}
                </li>
              ))}
            </ul>
            {busyDays.free > 0 && (
              <button type="button" className={`${s.secondary} ${s.small}`} disabled={busy} onClick={() => void submit(true)}>
                Забронировать остальные ({busyDays.free})
              </button>
            )}
          </div>
        )}
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primary} disabled={busy}>
          {editing ? "Сохранить" : "Забронировать"}
        </button>
      </form>
    </Dialog>
  );
}

const GUEST_HOURS: { hours: number; label: string }[] = [
  { hours: 1, label: "1 час" },
  { hours: 4, label: "4 часа" },
  { hours: 24, label: "Сутки" },
  { hours: 24 * 7, label: "Неделя" },
];

/** Кто может звать гостей — как на сервере (app/api/guests.py → can_invite_guests). */
function canInviteGuests(detail: StarDetail, channel: StarChannel, myId: string | undefined): boolean {
  const door = roomDoor(detail, channel, myId);
  if (door.kind === "open") return can(detail, "invite");
  return door.canAnswer;
}

/** Гостевая ссылка: человек без аккаунта заходит только в эту комнату. */
function GuestLinks({ detail, channel }: { detail: StarDetail; channel: StarChannel }) {
  const myId = useAuthStore((st) => st.user?.id);
  const allowed = canInviteGuests(detail, channel, myId);
  const [links, setLinks] = useState<GuestLink[]>([]);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLinks(await starsApi.guestLinks(detail.id, channel.id));
  }, [detail.id, channel.id]);

  useEffect(() => {
    if (allowed) void reload().catch(() => {});
  }, [allowed, reload]);

  if (!allowed) return null;

  const copy = (code: string) =>
    void navigator.clipboard
      ?.writeText(guestLinkUrl(code))
      .then(() => {
        setCopied(code);
        setTimeout(() => setCopied(null), 1500);
      })
      // Браузер не дал доступ к буферу (вкладка не в фокусе) — ссылка видна в списке.
      .catch(() => {});

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await starsApi.createGuestLink(detail.id, channel.id, hours);
      await reload();
      copy(link.code);
      setOpen(false);
    } catch (err) {
      setError(apiError(err, "Не удалось создать ссылку"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={w.bookings}>
      <div className={s.row}>
        <span className={w.sectionTitle} style={{ flex: 1 }}>
          Гости
        </span>
        <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => setOpen((o) => !o)}>
          🔗 Позвать гостя
        </button>
      </div>
      {open && (
        <div className={s.row}>
          <select className={s.select} style={{ width: "auto" }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {GUEST_HOURS.map((h) => (
              <option key={h.hours} value={h.hours}>
                Ссылка на {h.label.toLowerCase()}
              </option>
            ))}
          </select>
          <button type="button" className={`${s.primary} ${s.small}`} disabled={busy} onClick={() => void create()}>
            Создать и скопировать
          </button>
        </div>
      )}
      {open && (
        <p className={s.hint}>
          По ссылке человек без аккаунта войдёт только в «{channel.name}»: Спутников, участников и других комнат он не
          увидит. Отзовёте ссылку — гостей по ней выведет из комнаты.
        </p>
      )}
      {links.length > 0 && <div className={w.bookingList}>{links.map((link) => (
        <div key={link.id} className={`${w.booking} ${w.guestLink}`}>
          <span className={w.bookingTitle}>
            Действует до {formatWhen(link.expires_at)} · входов: {link.uses}
          </span>
          <button type="button" className={`${s.secondary} ${s.small}`} onClick={() => copy(link.code)}>
            {copied === link.code ? "Скопировано" : "Копировать"}
          </button>
          <button
            type="button"
            className={`${s.danger} ${s.small}`}
            onClick={() => {
              if (!window.confirm("Отозвать ссылку? Гостей по ней выведет из комнаты.")) return;
              void starsApi
                .revokeGuestLink(detail.id, link.id)
                .then(reload)
                .catch((err) => setError(apiError(err)));
            }}
          >
            Отозвать
          </button>
        </div>
      ))}</div>}
      {error && <div className={s.error}>{error}</div>}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { guestLinkUrl, starsApi, type DoorSignKind, type GuestLink, type StarChannel, type StarDetail } from "../../api/stars";
import { can, roomDoor } from "./rules";
import { formatWhen } from "../../chat/when";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import Dialog from "./Dialog";
import { apiError } from "./rules";
import { bookingRange, currentBooking, DOOR_SIGNS, doorSign, hhmm, upcomingBookings, useBookings } from "./work";
import s from "./Constellation.module.css";
import g from "./Gaming.module.css";
import w from "./Work.module.css";

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
  const [error, setError] = useState<string | null>(null);
  const list = upcomingBookings(bookings, channel.id, now);
  const current = currentBooking(bookings, channel.id, now);
  const isAdmin = detail.my_role === "owner" || detail.my_role === "admin";
  const nameOf = (id: string | null) =>
    detail.members.find((m) => m.user.id === id)?.user.username ?? "бывший участник";

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
      {list.slice(0, 6).map((b) => {
        const mine = b.created_by === myId;
        const invited = myId ? b.attendees.includes(myId) : false;
        return (
          <div key={b.id} className={b.id === current?.id ? `${w.booking} ${w.bookingNow}` : w.booking}>
            <span className={w.bookingWhen}>{bookingRange(b)}</span>
            <span className={w.bookingTitle} title={`${b.title} · бронь: ${nameOf(b.created_by)}`}>
              {b.title}
              {invited ? " · вас позвали" : ""}
            </span>
            {(mine || isAdmin) && (
              <button
                type="button"
                className={`${s.secondary} ${s.small}`}
                onClick={() => {
                  if (!window.confirm(`Отменить бронь «${b.title}»?`)) return;
                  setError(null);
                  void cancelBooking(b).catch((err) => setError(apiError(err, "Не удалось отменить")));
                }}
              >
                Отменить
              </button>
            )}
          </div>
        );
      })}
      {error && <div className={s.error}>{error}</div>}
      {open && createPortal(<BookingDialog detail={detail} channel={channel} onClose={() => setOpen(false)} />, document.body)}
    </div>
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

function BookingDialog({ detail, channel, onClose }: { detail: StarDetail; channel: StarChannel; onClose: () => void }) {
  const myId = useAuthStore((st) => st.user?.id);
  const book = useStarsStore((st) => st.book);
  const start = nextSlot();
  const [date, setDate] = useState(localDate(start));
  const [from, setFrom] = useState(localTime(start));
  const [to, setTo] = useState(localTime(new Date(start.getTime() + 60 * 60_000)));
  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = detail.members.filter(
    (m) => m.user.id !== myId && m.user.username.toLowerCase().includes(query.trim().toLowerCase())
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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
    setBusy(true);
    setError(null);
    try {
      await book(channel.id, {
        title: title.trim() || "Встреча",
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        attendees: [...attendees],
      });
      onClose();
    } catch (err) {
      setError(apiError(err, "Не удалось забронировать"));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Бронь: ${channel.name}`} onClose={onClose}>
      <form className={g.form} onSubmit={(e) => void submit(e)}>
        <label className={s.label}>
          Тема
          <input className={s.input} value={title} maxLength={100} autoFocus placeholder="Планёрка" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className={s.label}>
          День
          <input className={s.input} type="date" value={date} min={localDate(new Date())} onChange={(e) => setDate(e.target.value)} />
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
                {m.user.username}
              </label>
            ))}
          </div>
        </div>
        <p className={s.hint}>
          За 10 минут всем придёт напоминание, а на время встречи статус станет «на встрече» (кроме
          тех, кто сам поставил «не беспокоить»). До 8 часов, не дальше чем на 60 дней вперёд.
        </p>
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primary} disabled={busy}>
          Забронировать
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
      {links.map((link) => (
        <div key={link.id} className={w.booking} style={{ flexWrap: "wrap" }}>
          <span className={w.bookingTitle} style={{ flexBasis: "100%" }}>
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
      ))}
      {error && <div className={s.error}>{error}</div>}
    </div>
  );
}

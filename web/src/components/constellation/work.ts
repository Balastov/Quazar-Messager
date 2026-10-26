// Рабочие Звёзды: брони переговорных и таблички на дверях кабинетов.
import { useEffect, useState } from "react";
import type { DoorSignKind, StarBooking, StarChannel, StarDetail } from "../../api/stars";
import { useAuthStore } from "../../store/auth";
import { useStarsStore } from "../../store/stars";
import { memberWorkState } from "../../chat/workhours";

const NO_BOOKINGS: StarBooking[] = [];

export const DOOR_SIGNS: Record<DoorSignKind, { icon: string; label: string }> = {
  dnd: { icon: "⛔", label: "Не беспокоить" },
  welcome: { icon: "👋", label: "Заходите" },
  away: { icon: "🕒", label: "Скоро вернусь" },
  custom: { icon: "📝", label: "Своя надпись" },
};

/** Табличка на двери сейчас (истёкшую не показываем). */
export function doorSign(channel: StarChannel, now = Date.now()): { kind: DoorSignKind; icon: string; text: string } | null {
  const kind = channel.door_sign_kind;
  if (!kind || !DOOR_SIGNS[kind]) return null;
  if (channel.door_sign_until && Date.parse(channel.door_sign_until) <= now) return null;
  const text = kind === "custom" ? (channel.door_sign_text ?? "") : (channel.door_sign_text || DOOR_SIGNS[kind].label);
  return { kind, icon: DOOR_SIGNS[kind].icon, text };
}

/** На двери «Не беспокоить» — спросить, точно ли стучаться. */
export function confirmKnock(channel: StarChannel): boolean {
  const sign = doorSign(channel);
  return sign?.kind !== "dnd" || window.confirm(`На двери табличка «${sign.text}». Всё равно постучаться?`);
}

/** Идущая сейчас бронь комнаты. */
export function currentBooking(bookings: StarBooking[], channelId: string, now = Date.now()): StarBooking | null {
  return (
    bookings.find(
      (b) => b.channel_id === channelId && Date.parse(b.starts_at) <= now && Date.parse(b.ends_at) > now
    ) ?? null
  );
}

/** Брони комнаты, которые ещё не закончились, по порядку. */
export function upcomingBookings(bookings: StarBooking[], channelId: string, now = Date.now()): StarBooking[] {
  return bookings
    .filter((b) => b.channel_id === channelId && Date.parse(b.ends_at) > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** «сегодня 14:00–15:00», «28 окт. 10:00–11:30». */
export function bookingRange(b: StarBooking, now = new Date()): string {
  const start = new Date(b.starts_at);
  const sameDay = start.toDateString() === now.toDateString();
  const day = sameDay ? "сегодня" : start.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  return `${day} ${hhmm(b.starts_at)}–${hhmm(b.ends_at)}`;
}

/** Брони Звезды «Работа»: грузятся при открытии и пересчитываются раз в минуту (кто сейчас «занят»). */
export function useBookings(detail: StarDetail): { bookings: StarBooking[]; now: number } {
  const bookings = useStarsStore((st) => st.bookings[detail.id] ?? NO_BOOKINGS);
  const loaded = useStarsStore((st) => detail.id in st.bookings);
  const loadBookings = useStarsStore((st) => st.loadBookings);
  const [now, setNow] = useState(() => Date.now());
  const isWork = detail.kind === "work";

  useEffect(() => {
    if (isWork && !loaded) void loadBookings(detail.id).catch(() => {});
  }, [isWork, loaded, detail.id, loadBookings]);

  useEffect(() => {
    if (!isWork) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [isWork]);

  return { bookings, now };
}

/** У меня сейчас нерабочее время в этой Звезде (если там включено рабочее время): без звуков и уведомлений. */
export function amResting(starId: string, now = new Date()): boolean {
  const detail = useStarsStore.getState().details[starId];
  const myId = useAuthStore.getState().user?.id;
  const me = detail?.members.find((m) => m.user.id === myId);
  if (!detail || !me) return false;
  const state = memberWorkState(detail, me, now);
  return state !== null && !state.working;
}

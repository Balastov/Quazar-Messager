import { http } from "./client";

export type InboxKind =
  | "booking_invite"
  | "booking_cancelled"
  | "booking_soon"
  | "booking_started"
  /** Бронь изменили: тема, время или участники. */
  | "booking_changed"
  /** День серии не забронирован: комната была занята. */
  | "booking_busy";

/** Уведомление зелёного колокольчика. */
export interface InboxItem {
  id: string;
  kind: InboxKind | string;
  title: string;
  body: string;
  /** Куда ведёт нажатие: star_id и channel_id комнаты, booking_id, время встречи. */
  data: { star_id?: string; channel_id?: string; booking_id?: string; title?: string; starts_at?: string; ends_at?: string };
  created_at: string;
  read_at: string | null;
}

export interface InboxPage {
  items: InboxItem[];
  unread: number;
}

export const inboxApi = {
  list: (before?: string) =>
    http.get<InboxPage>("/inbox", { params: before ? { before } : undefined }).then((r) => r.data),
  read: (id: string) => http.post<{ unread: number }>(`/inbox/${id}/read`).then((r) => r.data),
  readAll: () => http.post<{ unread: number }>("/inbox/read-all").then((r) => r.data),
};

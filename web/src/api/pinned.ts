import { http } from "./client";

export type PinKind = "chats" | "contacts";
/** Закреплённые в списках: сверху — закреплённый последним. «Записная книжка» сверху всегда. */
export interface Pinned {
  chats: string[];
  contacts: string[];
  /** 5, с Premium — 10. */
  limit: number;
  /** Номер версии: более старое состояние (событие пришло с опозданием) не применяем. */
  rev: number;
}

export const pinnedApi = {
  list: () => http.get<Pinned>("/users/me/pinned").then((r) => r.data),
  pin: (kind: PinKind, id: string) => http.put<Pinned>(`/users/me/pinned/${kind}/${id}`).then((r) => r.data),
  unpin: (kind: PinKind, id: string) => http.delete<Pinned>(`/users/me/pinned/${kind}/${id}`).then((r) => r.data),
};

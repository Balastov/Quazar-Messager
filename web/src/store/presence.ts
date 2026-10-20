/**
 * Кто в сети. Сервер присылает сводку при каждом подключении сокета (presence_snapshot)
 * и потом — изменения (presence). Видны только те, с кем общий чат или Звезда, и контакты.
 *
 * Подписка — при загрузке модуля: сводка приходит сразу после подключения сокета,
 * раньше, чем отрисуется любой экран.
 */
import { create } from "zustand";
import { socket } from "../ws/socket";
import { usersApi } from "../api/users";
import { useAuthStore } from "./auth";
import {
  activeManual,
  presenceText,
  statusFromEvent,
  type ManualKind,
  type ManualStatus,
  type PresenceKind,
  type PresenceStatus,
} from "../utils/presence";

export type { PresenceStatus };

interface PresenceState {
  byId: Record<string, PresenceStatus>;
  /** Раз в минуту — чтобы «был(а) 5 мин назад» не застывало. */
  minute: number;
}

type ServerStatus = {
  user_id: string;
  status?: PresenceKind;
  online: boolean;
  away_since?: string | null;
  last_seen: string | null;
  manual?: ManualStatus | null;
};
type PresenceEvent = ({ type: "presence" } & ServerStatus) | { type: "presence_snapshot"; users: ServerStatus[] };

export const usePresenceStore = create<PresenceState>(() => ({ byId: {}, minute: 0 }));

if (typeof window !== "undefined") {
  window.setInterval(() => usePresenceStore.setState((st) => ({ minute: st.minute + 1 })), 60_000);
}

socket.on((raw) => {
  const event = raw as unknown as PresenceEvent;
  if (event.type === "presence_snapshot") {
    usePresenceStore.setState({
      byId: Object.fromEntries(event.users.map((u) => [u.user_id, statusFromEvent(u)])),
    });
  } else if (event.type === "presence") {
    usePresenceStore.setState((st) => ({
      byId: { ...st.byId, [event.user_id]: statusFromEvent(event) },
    }));
  }
});

export function usePresence(userId: string | null | undefined): PresenceStatus | undefined {
  return usePresenceStore((st) => (userId ? st.byId[userId] : undefined));
}

/** Мой ручной статус (действующий). */
export function useMyManualStatus(): ManualStatus | null {
  const myId = useAuthStore((st) => st.user?.id);
  const status = usePresence(myId);
  usePresenceStore((st) => st.minute);
  return activeManual(status);
}

/** Включено ли у меня «Не беспокоить» — для уведомлений и звуков. */
export function isDoNotDisturb(): boolean {
  const myId = useAuthStore.getState().user?.id;
  const status = myId ? usePresenceStore.getState().byId[myId] : undefined;
  return activeManual(status)?.kind === "dnd";
}

/** Поставить статус; minutes=null — пока не сниму; kind=null — снять. */
export async function setMyManualStatus(kind: ManualKind | null, until: Date | null): Promise<void> {
  await usersApi.setStatus({ kind, until: kind && until ? until.toISOString() : null });
  // Сервер пришлёт presence и нам — но обновим сразу, не дожидаясь.
  const myId = useAuthStore.getState().user?.id;
  if (!myId) return;
  usePresenceStore.setState((st) => {
    const prev = st.byId[myId] ?? statusFromEvent({ status: "online", online: true, last_seen: null });
    return {
      byId: {
        ...st.byId,
        [myId]: { ...prev, manual: kind ? { kind, until: until ? until.toISOString() : null } : null },
      },
    };
  });
}

/** «в сети» / «был(а) …» — пересчитывается каждую минуту. */
export function usePresenceText(userId: string | null | undefined): string | null {
  const status = usePresence(userId);
  usePresenceStore((st) => st.minute);
  return presenceText(status);
}

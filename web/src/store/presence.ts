/**
 * Кто в сети. Сервер присылает сводку при каждом подключении сокета (presence_snapshot)
 * и потом — изменения (presence). Видны только те, с кем общий чат или Звезда, и контакты.
 *
 * Подписка — при загрузке модуля: сводка приходит сразу после подключения сокета,
 * раньше, чем отрисуется любой экран.
 */
import { create } from "zustand";
import { socket } from "../ws/socket";
import { presenceText, type PresenceStatus } from "../utils/presence";

export type { PresenceStatus };

interface PresenceState {
  byId: Record<string, PresenceStatus>;
  /** Раз в минуту — чтобы «был(а) 5 мин назад» не застывало. */
  minute: number;
}

type PresenceEvent =
  | { type: "presence"; user_id: string; online: boolean; last_seen: string | null }
  | {
      type: "presence_snapshot";
      users: { user_id: string; online: boolean; last_seen: string | null }[];
    };

export const usePresenceStore = create<PresenceState>(() => ({ byId: {}, minute: 0 }));

if (typeof window !== "undefined") {
  window.setInterval(() => usePresenceStore.setState((st) => ({ minute: st.minute + 1 })), 60_000);
}

socket.on((raw) => {
  const event = raw as unknown as PresenceEvent;
  if (event.type === "presence_snapshot") {
    usePresenceStore.setState({
      byId: Object.fromEntries(
        event.users.map((u) => [u.user_id, { online: u.online, lastSeen: u.last_seen }])
      ),
    });
  } else if (event.type === "presence") {
    usePresenceStore.setState((st) => ({
      byId: { ...st.byId, [event.user_id]: { online: event.online, lastSeen: event.last_seen } },
    }));
  }
});

export function usePresence(userId: string | null | undefined): PresenceStatus | undefined {
  return usePresenceStore((st) => (userId ? st.byId[userId] : undefined));
}

/** «в сети» / «был(а) …» — пересчитывается каждую минуту. */
export function usePresenceText(userId: string | null | undefined): string | null {
  const status = usePresence(userId);
  usePresenceStore((st) => st.minute);
  return presenceText(status);
}

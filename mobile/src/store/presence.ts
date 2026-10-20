/**
 * Кто в сети (как в вебе): сводка при подключении сокета и изменения после.
 * Подписка — при загрузке модуля, чтобы не пропустить сводку.
 */
import {create} from 'zustand';
import {socket} from '../ws/socket';
import {
  activeManual,
  presenceText,
  statusFromEvent,
  type ManualKind,
  type ManualStatus,
  type PresenceKind,
  type PresenceStatus,
} from '../utils/presence';
import {usersApi} from '../api/users';
import {useAuthStore} from './auth';

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
type PresenceEvent = ({type: 'presence'} & ServerStatus) | {type: 'presence_snapshot'; users: ServerStatus[]};

export const usePresenceStore = create<PresenceState>(() => ({byId: {}, minute: 0}));

setInterval(() => usePresenceStore.setState(st => ({minute: st.minute + 1})), 60_000);

socket.on(raw => {
  const event = raw as unknown as PresenceEvent;
  if (event.type === 'presence_snapshot') {
    usePresenceStore.setState({
      byId: Object.fromEntries(event.users.map(u => [u.user_id, statusFromEvent(u)])),
    });
  } else if (event.type === 'presence') {
    usePresenceStore.setState(st => ({
      byId: {...st.byId, [event.user_id]: statusFromEvent(event)},
    }));
  }
});

/** Что показать точкой: online / away / busy (ручной статус) / ничего. */
export function usePresenceKind(userId: string | null | undefined): PresenceKind | 'busy' | undefined {
  const status = usePresenceStore(st => (userId ? st.byId[userId] : undefined));
  usePresenceStore(st => st.minute);
  if (activeManual(status)) {
    return 'busy';
  }
  return status?.status;
}

export function useMyManualStatus(): ManualStatus | null {
  const myId = useAuthStore(st => st.user?.id);
  const status = usePresenceStore(st => (myId ? st.byId[myId] : undefined));
  usePresenceStore(st => st.minute);
  return activeManual(status);
}

/** Поставить статус; until=null — пока не сниму; kind=null — снять. */
export async function setMyManualStatus(kind: ManualKind | null, until: Date | null): Promise<void> {
  await usersApi.setStatus({kind, until: kind && until ? until.toISOString() : null});
  const myId = useAuthStore.getState().user?.id;
  if (!myId) {
    return;
  }
  usePresenceStore.setState(st => {
    const prev = st.byId[myId] ?? statusFromEvent({status: 'online', online: true, last_seen: null});
    return {
      byId: {...st.byId, [myId]: {...prev, manual: kind ? {kind, until: until ? until.toISOString() : null} : null}},
    };
  });
}

/** «в сети» / «был(а) …» — пересчитывается каждую минуту. */
export function usePresenceText(userId: string | null | undefined): string | null {
  const status = usePresenceStore(st => (userId ? st.byId[userId] : undefined));
  usePresenceStore(st => st.minute);
  return presenceText(status);
}

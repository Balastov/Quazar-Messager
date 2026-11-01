import { create } from "zustand";
import axios from "axios";
import {
  roomActivitiesApi, type BoardItem, type BoardItemBody, type FocusAction,
  type RoomActivityEvent, type RoomSnapshot, type ScreenPointer, type VideoAction,
} from "../api/roomActivities";
import { useAuthStore } from "./auth";
import { socket } from "../ws/socket";
import { notifyInfo } from "../notifications/notify";
import { focusAt } from "../components/constellation/roomActivityMath";

export interface RoomCache extends Omit<RoomSnapshot, "board"> {
  board: Record<string, BoardItem>;
  itemVersions: Record<string, number>;
  resetRevision: number;
  stateRevision: number;
  clockOffset: number;
  ready: boolean;
  pointers: Record<string, ScreenPointer & { expires: number }>;
}

export function emptyRoom(starId: string, channelId: string): RoomCache {
  return { star_id: starId, channel_id: channelId, revision: 0, server_time: "", pointers_sharer_id: null,
    focus: null, video: null, videos: [], board: {}, itemVersions: {}, resetRevision: 0, stateRevision: -1,
    clockOffset: 0, ready: false, pointers: {} };
}

function header(cache: RoomCache, state: Omit<RoomSnapshot, "board">): RoomCache {
  if (state.revision < cache.stateRevision) return cache;
  return { ...cache, ...state, revision: Math.max(cache.revision, state.revision), stateRevision: state.revision,
    clockOffset: cache.ready ? cache.clockOffset : Date.parse(state.server_time) - Date.now(),
    pointers: state.pointers_sharer_id === cache.pointers_sharer_id ? cache.pointers : {} };
}

/** Поздний GET не затирает пришедшие после него изменения и удаления объектов. */
export function mergeRoomSnapshot(cache: RoomCache, snapshot: RoomSnapshot, clockOffset?: number): RoomCache {
  const { board: items, ...state } = snapshot;
  const next = header(cache, state);
  const board = { ...cache.board }, versions = { ...cache.itemVersions };
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    if (item.revision >= (versions[item.id] ?? 0) && item.revision > cache.resetRevision) {
      board[item.id] = item;
      versions[item.id] = item.revision;
    }
  }
  for (const [id, item] of Object.entries(board)) {
    if (!ids.has(id) && item.revision <= snapshot.revision) {
      delete board[id];
      versions[id] = snapshot.revision;
    }
  }
  return { ...next, clockOffset: clockOffset ?? next.clockOffset, board, itemVersions: versions,
    resetRevision: Math.max(cache.resetRevision, snapshot.revision), ready: true };
}

export function applyRoomEvent(cache: RoomCache, event: RoomActivityEvent): RoomCache {
  if (event.type === "room_activity_state") return header(cache, event);
  if (event.type === "room_pointer") {
    if (event.sharer_id !== cache.pointers_sharer_id) return cache;
    return { ...cache, pointers: { ...cache.pointers, [event.user_id]: { ...event, expires: Date.now() + 3500 } } };
  }
  if (event.revision <= cache.resetRevision) return cache;
  if (event.type === "room_board_reset") {
    return { ...cache, board: Object.fromEntries(Object.entries(cache.board).filter(([, item]) => item.revision > event.revision)),
      resetRevision: event.revision, revision: Math.max(cache.revision, event.revision) };
  }
  if (event.revision <= (cache.itemVersions[event.item_id] ?? 0)) return cache;
  const board = { ...cache.board };
  if (event.item) board[event.item_id] = event.item;
  else delete board[event.item_id];
  return { ...cache, board, itemVersions: { ...cache.itemVersions, [event.item_id]: event.revision },
    revision: Math.max(cache.revision, event.revision) };
}

interface RoomActivityState {
  userId: string | null;
  rooms: Record<string, RoomCache>;
  load: (starId: string, channelId: string) => Promise<void>;
  setPointers: (starId: string, channelId: string, enabled: boolean) => Promise<void>;
  point: (starId: string, channelId: string, sharerId: string, x: number, y: number) => void;
  putItem: (starId: string, channelId: string, id: string, body: BoardItemBody) => Promise<void>;
  deleteItem: (starId: string, channelId: string, item: BoardItem) => Promise<void>;
  clearBoard: (starId: string, channelId: string) => Promise<void>;
  focus: (starId: string, channelId: string, action: FocusAction, workMinutes?: number, breakMinutes?: number) => Promise<void>;
  video: (starId: string, channelId: string, action: VideoAction, extra?: {
    file_id?: string; position?: number; duration?: number; shared_controls?: boolean; version?: number;
  }) => Promise<void>;
  uploadVideo: (starId: string, channelId: string, file: File, progress: (share: number) => void) => Promise<void>;
  deleteVideo: (starId: string, channelId: string, id: string) => Promise<void>;
}

export const useRoomActivities = create<RoomActivityState>((set, get) => {
  const userId = () => useAuthStore.getState().user?.id ?? null;
  const patch = (starId: string, channelId: string, fn: (cache: RoomCache) => RoomCache) => {
    if (get().userId !== userId()) return;
    set((s) => ({ rooms: { ...s.rooms, [channelId]: fn(s.rooms[channelId] ?? emptyRoom(starId, channelId)) } }));
  };
  const accept = (snapshot: RoomSnapshot, clockOffset?: number) =>
    patch(snapshot.star_id, snapshot.channel_id, (cache) => mergeRoomSnapshot(cache, snapshot, clockOffset));
  const change = async (starId: string, channelId: string, fn: () => Promise<RoomSnapshot>) => {
    const account = userId();
    try {
      const snapshot = await fn();
      if (account === userId()) accept(snapshot);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) await get().load(starId, channelId).catch(() => {});
      throw error;
    }
  };
  socket.on((event) => {
    if (get().userId !== userId()) return;
    if (!event.type.startsWith("room_") || !("channel_id" in event) || !get().rooms[event.channel_id]) return;
    const roomEvent = event as RoomActivityEvent;
    const before = get().rooms[roomEvent.channel_id];
    patch(roomEvent.star_id, roomEvent.channel_id, (cache) => applyRoomEvent(cache, roomEvent));
    if (roomEvent.type === "room_activity_state" && roomEvent.revision > before.stateRevision && before.focus?.running &&
        roomEvent.focus?.phase !== before.focus.phase && roomEvent.focus?.phase !== "work") {
      notifyInfo({ title: roomEvent.focus?.phase === "break" ? "Время перерыва" : "Сеанс фокуса завершён",
        body: roomEvent.focus?.phase === "break" ? "Комната переходит к общему перерыву" : "Можно начать новый сеанс" });
    }
  });
  return {
    userId: null, rooms: {},
    load: async (starId, channelId) => {
      const account = userId();
      if (get().userId !== account) set({ userId: account, rooms: {} });
      patch(starId, channelId, (cache) => cache);
      const started = performance.now();
      const snapshot = await roomActivitiesApi.get(starId, channelId);
      // Часы калибруем коротким GET, учитывая половину RTT. Время загрузки файла
      // или задержка отдельного WebSocket-события не сдвигают общий плеер.
      const offset = Date.parse(snapshot.server_time) + (performance.now() - started) / 2 - Date.now();
      if (account === userId()) accept(snapshot, offset);
    },
    setPointers: (starId, channelId, enabled) => change(starId, channelId, () => roomActivitiesApi.pointers(starId, channelId, enabled)),
    point: (starId, channelId, sharerId, x, y) => {
      if (!socket.isOpen()) return;
      socket.send({ type: "room_pointer", star_id: starId, channel_id: channelId, sharer_id: sharerId, x, y });
    },
    putItem: async (starId, channelId, id, body) => {
      const account = userId();
      try {
        const item = await roomActivitiesApi.putItem(starId, channelId, id, body);
        if (account === userId()) patch(starId, channelId, (cache) => applyRoomEvent(cache, {
          type: "room_board_item", star_id: starId, channel_id: channelId, item_id: id, item, revision: item.revision,
        }));
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) await get().load(starId, channelId).catch(() => {});
        throw error;
      }
    },
    deleteItem: async (starId, channelId, item) => {
      const account = userId();
      try {
        const out = await roomActivitiesApi.deleteItem(starId, channelId, item);
        if (account === userId()) patch(starId, channelId, (cache) => applyRoomEvent(cache, {
          type: "room_board_item", star_id: starId, channel_id: channelId, item_id: item.id, item: null, revision: out.revision,
        }));
      } catch (error) {
        await get().load(starId, channelId).catch(() => {});
        throw error;
      }
    },
    clearBoard: async (starId, channelId) => {
      const account = userId();
      const out = await roomActivitiesApi.clearBoard(starId, channelId);
      if (account === userId()) patch(starId, channelId, (cache) => applyRoomEvent(cache, {
        type: "room_board_reset", star_id: starId, channel_id: channelId, revision: out.revision,
      }));
    },
    focus: (starId, channelId, action, workMinutes, breakMinutes) => change(starId, channelId,
      () => {
        const cache = get().rooms[channelId];
        return roomActivitiesApi.focus(starId, channelId, action,
          focusAt(cache?.focus ?? null, Date.now() + (cache?.clockOffset ?? 0))?.version ?? 0, workMinutes, breakMinutes);
      }),
    video: (starId, channelId, action, extra) => change(starId, channelId,
      () => roomActivitiesApi.video(starId, channelId, { action, version: get().rooms[channelId]?.video?.version ?? 0, ...extra })),
    uploadVideo: (starId, channelId, file, progress) => change(starId, channelId, () => roomActivitiesApi.uploadVideo(starId, channelId, file, progress)),
    deleteVideo: (starId, channelId, id) => change(starId, channelId, () => roomActivitiesApi.deleteVideo(starId, channelId, id)),
  };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardItem, RoomSnapshot } from "../../api/roomActivities";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
});
const handlers: ((event: unknown) => void)[] = [];
vi.mock("../../ws/socket", () => ({ socket: {
  on: (fn: (event: unknown) => void) => { handlers.push(fn); return () => {}; },
  onStatus: () => () => {}, send: vi.fn(), isOpen: () => true,
} }));
vi.mock("../../api/roomActivities", () => ({ roomActivitiesApi: {
  get: vi.fn(), putItem: vi.fn(), deleteItem: vi.fn(), clearBoard: vi.fn(), pointers: vi.fn(),
  focus: vi.fn(), video: vi.fn(), uploadVideo: vi.fn(), deleteVideo: vi.fn(),
} }));

const { emptyRoom, applyRoomEvent, mergeRoomSnapshot, useRoomActivities } = await import("../roomActivities");
const { roomActivitiesApi } = await import("../../api/roomActivities");
const { useAuthStore } = await import("../auth");
const { socket } = await import("../../ws/socket");

function item(id = "one", revision = 1): BoardItem {
  return { id, revision, kind: "note", text: id, x: 40, y: 40, points: [], color: "green", width: 3, updated_by: "me" };
}
function snapshot(revision = 1, board: BoardItem[] = []): RoomSnapshot {
  return { star_id: "star", channel_id: "room", revision, board, focus: null, video: null, videos: [],
    pointers_sharer_id: null, server_time: "2026-11-01T12:00:00Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "me", username: "я" } as never });
  useRoomActivities.setState({ userId: "me", rooms: {} });
});

describe("room activity collaboration", () => {
  it("merges different out-of-order board edits without losing either participant's item", () => {
    let cache = emptyRoom("star", "room");
    cache = applyRoomEvent(cache, { type: "room_board_item", star_id: "star", channel_id: "room", item_id: "two", item: item("two", 2), revision: 2 });
    cache = applyRoomEvent(cache, { type: "room_board_item", star_id: "star", channel_id: "room", item_id: "one", item: item("one", 1), revision: 1 });
    expect(Object.keys(cache.board).sort()).toEqual(["one", "two"]);
  });

  it("does not let an old GET undo a newer edit or resurrect a deletion", () => {
    let cache = mergeRoomSnapshot(emptyRoom("star", "room"), snapshot(1, [item()]));
    cache = applyRoomEvent(cache, { type: "room_board_item", star_id: "star", channel_id: "room", item_id: "one", item: null, revision: 3 });
    cache = applyRoomEvent(cache, { type: "room_board_item", star_id: "star", channel_id: "room", item_id: "two", item: item("two", 4), revision: 4 });
    cache = mergeRoomSnapshot(cache, snapshot(2, [item("one", 1)]));
    expect(cache.board.one).toBeUndefined();
    expect(cache.board.two.revision).toBe(4);
  });

  it("clears old board content while preserving edits made after the clear", () => {
    let cache = mergeRoomSnapshot(emptyRoom("star", "room"), snapshot(2, [item("one", 1), item("two", 2)]));
    cache = applyRoomEvent(cache, { type: "room_board_item", star_id: "star", channel_id: "room", item_id: "new", item: item("new", 5), revision: 5 });
    cache = applyRoomEvent(cache, { type: "room_board_reset", star_id: "star", channel_id: "room", revision: 4 });
    cache = applyRoomEvent(cache, { type: "room_board_item", star_id: "star", channel_id: "room", item_id: "old", item: item("old", 3), revision: 3 });
    expect(Object.keys(cache.board)).toEqual(["new"]);
  });

  it("does not rewind video state when older events arrive", () => {
    let cache = emptyRoom("star", "room");
    const { board: _, ...state } = snapshot(8);
    cache = applyRoomEvent(cache, { type: "room_activity_state", ...state, pointers_sharer_id: "alice" });
    cache = applyRoomEvent(cache, { type: "room_pointer", star_id: "star", channel_id: "room", user_id: "bob",
      name: "Боб", sharer_id: "alice", x: 0.5, y: 0.25, created_at: state.server_time });
    expect(cache.pointers.bob).toBeDefined();
    cache = applyRoomEvent(cache, { type: "room_activity_state", ...state, revision: 7 });
    expect(cache.pointers_sharer_id).toBe("alice");
    cache = applyRoomEvent(cache, { type: "room_activity_state", ...state, revision: 9, pointers_sharer_id: null });
    expect(cache.pointers).toEqual({});
  });

  it("updates the local board after a successful save without waiting for WebSocket echo", async () => {
    useRoomActivities.setState({ rooms: { room: emptyRoom("star", "room") } });
    vi.mocked(roomActivitiesApi.putItem).mockResolvedValue(item("new", 2));
    const { id, updated_by: _, ...body } = item("new", 0);
    await useRoomActivities.getState().putItem("star", "room", id, body);
    expect(useRoomActivities.getState().rooms.room.board.new.revision).toBe(2);
    expect(roomActivitiesApi.putItem).toHaveBeenCalledWith("star", "room", "new", body);
  });

  it("reloads after a conflicting edit and retains the server's newer object", async () => {
    vi.mocked(roomActivitiesApi.putItem).mockRejectedValue({ isAxiosError: true, response: { status: 409 } });
    vi.mocked(roomActivitiesApi.get).mockResolvedValue(snapshot(7, [item("one", 7)]));
    const { id, updated_by: _, ...body } = item();
    await expect(useRoomActivities.getState().putItem("star", "room", id, body)).rejects.toMatchObject({ response: { status: 409 } });
    expect(useRoomActivities.getState().rooms.room.board.one.revision).toBe(7);
  });

  it("ignores a pending room response after the account changes", async () => {
    let finish!: (state: RoomSnapshot) => void;
    vi.mocked(roomActivitiesApi.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const loading = useRoomActivities.getState().load("star", "room");
    useAuthStore.setState({ user: null });
    finish(snapshot(1, [item()]));
    await loading;
    expect(useRoomActivities.getState().rooms.room.board).toEqual({});
  });

  it("sends normalized pointer coordinates with the current room and sharer", () => {
    useRoomActivities.getState().point("star", "room", "alice", 0.25, 0.75);
    expect(socket.send).toHaveBeenCalledWith({ type: "room_pointer", star_id: "star", channel_id: "room", sharer_id: "alice", x: 0.25, y: 0.75 });
  });
});

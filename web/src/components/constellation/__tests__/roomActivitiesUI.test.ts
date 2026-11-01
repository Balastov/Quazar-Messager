import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarDetail, StarChannel } from "../../../api/stars";
import type { RoomSnapshot } from "../../../api/roomActivities";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, value: string) => void memory.set(k, value), removeItem: (k: string) => void memory.delete(k) });
vi.mock("../../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));
vi.mock("../../../api/roomActivities", () => ({ roomActivitiesApi: {
  get: vi.fn(), putItem: vi.fn(), deleteItem: vi.fn(), clearBoard: vi.fn(), pointers: vi.fn(), focus: vi.fn(),
  video: vi.fn(), uploadVideo: vi.fn(), deleteVideo: vi.fn(), videoBlob: vi.fn(),
} }));

const { emptyRoom, mergeRoomSnapshot, useRoomActivities } = await import("../../../store/roomActivities");
const { roomActivitiesApi } = await import("../../../api/roomActivities");
const { useAuthStore } = await import("../../../store/auth");
const { useVoiceStore } = await import("../../../store/voice");
const { default: RoomBoard } = await import("../RoomBoard");
const { default: FocusOrbit } = await import("../FocusOrbit");
const { default: RoomVideo } = await import("../RoomVideo");
const { default: ActivityFrame } = await import("../ActivityFrame");

let host: HTMLDivElement;
let root: Root;
const channel = { id: "room", star_id: "star", kind: "planet", name: "Комната" } as StarChannel;
const detail = { id: "star", name: "Звезда", kind: "work", my_role: "member", rules_accepted: true,
  channels: [channel], members: [
    { user: { id: "me", username: "me", display_name: "Анна" }, role: "member" },
    { user: { id: "alice", username: "alice", display_name: "Алиса" }, role: "member" },
  ], voice: { room: [{ user_id: "me", is_host: false }, { user_id: "alice", is_host: true }] },
} as unknown as StarDetail;

function state(): RoomSnapshot {
  return { star_id: "star", channel_id: "room", revision: 0, server_time: new Date().toISOString(),
    board: [], focus: null, video: null, videos: [], pointers_sharer_id: null };
}
function setRoom(snapshot: RoomSnapshot) {
  useRoomActivities.setState({ userId: "me", rooms: { room: mergeRoomSnapshot(emptyRoom("star", "room"), snapshot) } });
}
function button(text: string) {
  const result = [...host.querySelectorAll("button")].find((el) => el.textContent === text);
  if (!result) throw new Error(`Button missing: ${text}`);
  return result;
}
function Board() {
  const room = useRoomActivities((st) => st.rooms.room);
  return createElement(RoomBoard, { starId: "star", channelId: "room", room, readOnly: false, canClear: false });
}
function Focus() {
  const room = useRoomActivities((st) => st.rooms.room);
  return createElement(FocusOrbit, { detail, channel, room, readOnly: false });
}
function Video() {
  const room = useRoomActivities((st) => st.rooms.room);
  return createElement(RoomVideo, { detail, channel, room, readOnly: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  useAuthStore.setState({ user: { id: "me", username: "me" } as never });
  useVoiceStore.setState({ status: "connected", starId: "star", channelId: "room", deafened: false });
  setRoom(state());
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:quazar-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("room activities interface", () => {
  it("saves a note from the editor and renders text safely on the shared board", async () => {
    vi.mocked(roomActivitiesApi.putItem).mockImplementation(async (_star, _room, id, body) => ({ ...body, id, revision: 1, updated_by: "me" }));
    await act(async () => root.render(createElement(Board)));
    const input = host.querySelector("textarea")!;
    await act(async () => { input.value = "План <script>alert(1)</script>"; Simulate.change(input); });
    await act(async () => button("Добавить заметку").click());
    expect(roomActivitiesApi.putItem).toHaveBeenCalledOnce();
    expect(roomActivitiesApi.putItem).toHaveBeenCalledWith("star", "room", expect.any(String), expect.objectContaining({ kind: "note", text: "План <script>alert(1)</script>" }));
    expect(host.querySelector("svg")?.textContent).toContain("План");
    expect(host.querySelector("script")).toBeNull();
  });

  it("turns a pointer stroke into a persisted object and can undo that drawing", async () => {
    vi.mocked(roomActivitiesApi.putItem).mockImplementation(async (_star, _room, id, body) => ({ ...body, id, revision: 1, updated_by: "me" }));
    vi.mocked(roomActivitiesApi.deleteItem).mockResolvedValue({ revision: 2 });
    await act(async () => root.render(createElement(Board)));
    const svg = host.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1200, height: 700 } as DOMRect);
    await act(async () => svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 20 })));
    await act(async () => svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 100, clientY: 120 })));
    await act(async () => svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })));
    expect(roomActivitiesApi.putItem).toHaveBeenCalledWith("star", "room", expect.any(String), expect.objectContaining({
      kind: "stroke", points: [{ x: 10, y: 20 }, { x: 100, y: 120 }],
    }));
    expect(svg.querySelector("polyline")).not.toBeNull();
    await act(async () => button("Отменить мой рисунок").click());
    expect(svg.querySelector("polyline")).toBeNull();
  });

  it("starts a shared focus session with the chosen work and break durations", async () => {
    const next = { ...state(), revision: 1, focus: { owner_id: "me", version: 1, phase: "work" as const,
      running: true, work_seconds: 1500, break_seconds: 300, remaining_seconds: 1500,
      ends_at: new Date(Date.now() + 1500000).toISOString() } };
    vi.mocked(roomActivitiesApi.focus).mockResolvedValue(next);
    await act(async () => root.render(createElement(Focus)));
    await act(async () => button("Начать").click());
    await act(async () => button("Запустить для комнаты").click());
    expect(roomActivitiesApi.focus).toHaveBeenCalledWith("star", "room", "start", 0, 25, 5);
    expect(host.textContent).toContain("Фокус");
    expect(button("Пауза").disabled).toBe(false);
  });

  it("keeps followers' playback controls locked while personal volume remains available", async () => {
    setRoom({ ...state(), revision: 1, videos: [{ id: "v", name: "Ролик.mp4", mime: "video/mp4", size: 1000, uploader_id: "alice" }],
      video: { owner_id: "alice", version: 1, file_id: "v", playing: false, position: 0,
        updated_at: new Date().toISOString(), shared_controls: false } });
    vi.mocked(roomActivitiesApi.videoBlob).mockResolvedValue(new Blob(["video"], { type: "video/mp4" }));
    await act(async () => root.render(createElement(Video)));
    expect(button("Смотреть вместе").disabled).toBe(true);
    const volume = host.querySelector<HTMLInputElement>('[aria-label="Громкость видео у меня"]')!;
    await act(async () => { volume.value = "12"; Simulate.change(volume); });
    expect(host.querySelector("video")?.volume).toBe(0.12);
    expect(roomActivitiesApi.video).not.toHaveBeenCalled();
  });

  it("retains the conversation controls in an expanded board/video stage", async () => {
    await act(async () => root.render(createElement(ActivityFrame, { title: "Общая доска",
      controls: createElement("button", { "aria-label": "Микрофон" }, "Микрофон"),
      children: createElement("div", null, "Доска") })));
    const frame = host.querySelector("[data-activity-frame]")!;
    Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: undefined });
    await act(async () => button("На весь экран").click());
    const mic = document.querySelector('[aria-label="Микрофон"]');
    expect(mic).not.toBeNull();
    expect(mic?.closest("[class]")?.textContent).toContain("Микрофон");
    expect(document.body.textContent).toContain("Свернуть");
  });

  it("preserves an unsaved board draft while expanding and restoring the stage", async () => {
    await act(async () => root.render(createElement(ActivityFrame, { title: "Общая доска",
      controls: createElement("button", null, "Микрофон"), children: createElement(Board) })));
    const input = host.querySelector("textarea")!;
    await act(async () => { input.value = "Ещё не сохранённая заметка"; Simulate.change(input); });
    const frame = host.querySelector("[data-activity-frame]")!;
    Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: undefined });
    await act(async () => button("На весь экран").click());
    expect(document.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Ещё не сохранённая заметка");
    const restore = [...document.querySelectorAll("button")].find((el) => el.textContent === "Свернуть")!;
    await act(async () => restore.click());
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Ещё не сохранённая заметка");
  });
});

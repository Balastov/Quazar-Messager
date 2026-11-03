import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StarChannel, StarDetail } from "../../../api/stars";
import type { RoomCache } from "../../../store/roomActivities";

const state = vi.hoisted(() => ({
  auth: { user: { id: "me" } },
  stars: { bookings: { star: [] }, loadBookings: vi.fn(), cancelBooking: vi.fn(), setDoorSign: vi.fn() },
  activities: { focus: vi.fn() },
}));
vi.mock("../../../store/auth", () => ({ useAuthStore: (selector: (value: typeof state.auth) => unknown) => selector(state.auth) }));
vi.mock("../../../store/stars", () => ({ useStarsStore: (selector: (value: typeof state.stars) => unknown) => selector(state.stars) }));
vi.mock("../../../store/roomActivities", () => ({ useRoomActivities: (selector: (value: typeof state.activities) => unknown) => selector(state.activities) }));
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value) });
const { starsApi } = await import("../../../api/stars");
const { default: RoomTools } = await import("../RoomTools");
const { default: FocusOrbit } = await import("../FocusOrbit");

const channel = { id: "room", star_id: "star", name: "Переговорная", kind: "planet", room_kind: "meeting", access: "open" } as StarChannel;
const detail = { id: "star", kind: "work", my_role: "member", my_permissions: ["invite"], members: [], voice: {} } as unknown as StarDetail;
const room = { ready: true, clockOffset: 0, focus: null } as RoomCache;
let host: HTMLDivElement, root: Root;
function button(text: string) {
  const node = [...host.querySelectorAll("button")].find(el => el.textContent?.startsWith(text));
  if (!node) throw new Error(`Missing button: ${text}`);
  return node;
}
function panel(cache = room) {
  return createElement(RoomTools, { detail, channel,
    summary: createElement(FocusOrbit, { detail, channel, room: cache, readOnly: true, compact: true }),
    children: createElement(FocusOrbit, { detail, channel, room: cache, readOnly: false }),
  });
}
beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); state.auth.user.id = "me";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value) });
  vi.spyOn(starsApi, "guestLinks").mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("collapses the tools together without losing guest options or an unfinished timer configuration", async () => {
  await act(async () => root.render(panel()));
  await act(async () => button("🔗 Позвать гостя").click());
  const select = host.querySelector("select")!;
  await act(async () => { select.value = "4"; Simulate.change(select); });
  await act(async () => button("Начать").click());
  const minutes = host.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { minutes.value = "42"; Simulate.change(minutes); });
  const toggle = button("Свернуть");
  const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(body.hidden).toBe(true);
  await act(async () => button("Развернуть").click());
  expect(body.hidden).toBe(false);
  expect(host.querySelector("select")).toBe(select);
  expect(select.value).toBe("4");
  expect(host.querySelector('input[type="number"]')).toBe(minutes);
  expect(minutes.value).toBe("42");
  expect(starsApi.guestLinks).toHaveBeenCalledOnce();
  expect(state.activities.focus).not.toHaveBeenCalled();
});

it("remembers collapsing after remount and keeps the preference separate for another account", async () => {
  await act(async () => root.render(panel()));
  await act(async () => button("Свернуть").click());
  await act(async () => root.render(null));
  await act(async () => root.render(panel()));
  expect(button("Развернуть").getAttribute("aria-expanded")).toBe("false");
  state.auth.user.id = "other";
  await act(async () => root.render(panel()));
  expect(button("Свернуть").getAttribute("aria-expanded")).toBe("true");
});

it("keeps the running countdown visible in the collapsed header", async () => {
  const active = { ...room, focus: { owner_id: "me", version: 1, phase: "work" as const,
    running: true, work_seconds: 1500, break_seconds: 300, remaining_seconds: 1500,
    ends_at: new Date(Date.now() + 1_500_000).toISOString() } };
  await act(async () => root.render(panel(active)));
  await act(async () => button("Свернуть").click());
  const timers = [...host.querySelectorAll('[role="timer"]')];
  const visible = timers.filter(el => !el.closest("[hidden]"));
  expect(visible).toHaveLength(1);
  expect(visible[0].textContent).toMatch(/Фокус · 2[45]:\d\d/);
  expect(visible[0].querySelector("button")).toBeNull();
});

it("does not show an empty tools panel outside a work room", async () => {
  await act(async () => root.render(createElement(RoomTools, { detail: { ...detail, kind: "gaming" }, channel })));
  expect(host.querySelector("section")).toBeNull();
});

it("still collapses when browser storage is unavailable", async () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  await act(async () => root.render(panel()));
  await act(async () => button("Свернуть").click());
  expect(button("Развернуть").getAttribute("aria-expanded")).toBe("false");
});

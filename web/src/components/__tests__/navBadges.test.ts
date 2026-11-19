import {act, createElement} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
const memory = new Map<string, string>();
const storage = {getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k)};
vi.stubGlobal("localStorage", storage);
vi.mock("../../ws/socket", () => ({socket: {on: () => () => {}, onStatus: () => () => {}, send: () => {}}}));
const {default: AppNav} = await import("../AppNav");
const {useStarsStore} = await import("../../store/stars");
const {useUnreadStore} = await import("../../store/unread");
const {useAdminStore} = await import("../../store/admin");
const {useNotifyStore} = await import("../../notifications/levels");

let host: HTMLDivElement, root: Root;
const channel = (id: string, kind: "satellite" | "planet") => ({id, kind, name: id, position: 0, star_id: "star"});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", storage);
  useNotifyStore.setState({settings: {}, loaded: true});
  useUnreadStore.getState().replace({chat: 3});
  useStarsStore.setState({
    details: {star: {id: "star", channels: [channel("sat", "satellite"), channel("room", "planet"), channel("muted", "satellite")]}} as never,
    unread: {sat: {starId: "star", count: 2, mentions: 0}, room: {starId: "star", count: 1, mentions: 0}, muted: {starId: "star", count: 5, mentions: 0}},
  });
  useNotifyStore.setState({settings: {"channel:muted": {scope: "channel", target_id: "muted", level: "none", muted_until: null}}});
  useAdminStore.setState({isSuper: true, ticketsUnread: 4, newsDrafts: 0});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();});

const label = (name: string) =>
  [...host.querySelectorAll("aside button")].map((b) => b.getAttribute("aria-label") ?? "").find((l) => l.startsWith(name));

it("shows unread counters on Chats, Constellation and Black Hole", async () => {
  await act(async () => root.render(createElement(AppNav)));
  expect(label("Чаты")).toBe("Чаты, непрочитанных: 3");
  // Выключенный канал не считается: 2 из Спутника + 1 из чата комнаты.
  expect(label("Созвездие")).toBe("Созвездие, непрочитанных: 3");
  expect(label("Чёрная дыра")).toBe("Чёрная дыра, непрочитанных: 4");
});

it("hides a counter at zero", async () => {
  useAdminStore.setState({ticketsUnread: 0});
  useStarsStore.setState({unread: {}});
  await act(async () => root.render(createElement(AppNav)));
  expect(label("Созвездие")).toBeUndefined();
  expect(label("Чёрная дыра")).toBeUndefined();
});

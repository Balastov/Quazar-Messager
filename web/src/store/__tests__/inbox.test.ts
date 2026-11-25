import {beforeEach, expect, it, vi} from "vitest";

const handlers: ((event: any) => void)[] = [];
vi.mock("../../ws/socket", () => ({socket: {on: (fn: (event: any) => void) => {handlers.push(fn); return () => {};}, onStatus: () => () => {}}}));
const api = vi.hoisted(() => ({list: vi.fn(), read: vi.fn(), readAll: vi.fn()}));
vi.mock("../../api/inbox", () => ({inboxApi: api}));
const notifyInbox = vi.hoisted(() => vi.fn());
vi.mock("../../notifications/notify", () => ({notifyInbox}));
const openChannelLink = vi.hoisted(() => vi.fn());
vi.mock("../stars", () => ({useStarsStore: {getState: () => ({openChannelLink})}}));
const {useInboxStore} = await import("../inbox");

const item = (id: string, read = false) => ({
  id, kind: "booking_invite", title: `Встреча ${id}`, body: "«Переговорная»", created_at: "2026-11-19T10:00:00Z",
  read_at: read ? "2026-11-19T10:05:00Z" : null, data: {star_id: "star", channel_id: "room", booking_id: "b"},
});
const emit = (event: object) => handlers.forEach((fn) => fn(event));

beforeEach(() => {
  vi.clearAllMocks();
  useInboxStore.getState().reset();
});

it("shows a new notification live and raises the counter", () => {
  emit({type: "inbox_new", notification: item("n1"), unread: 1});
  emit({type: "inbox_new", notification: item("n1"), unread: 1});
  expect(useInboxStore.getState().items.map((i) => i.id)).toEqual(["n1"]);
  expect(useInboxStore.getState().unread).toBe(1);
  expect(notifyInbox).toHaveBeenCalledWith({id: "n1", kind: "booking_invite", title: "Встреча n1", body: "«Переговорная»", starId: "star", channelId: "room"});
});

it("opening marks it read, lowers the counter and goes to the room", async () => {
  api.list.mockResolvedValue({items: [item("a"), item("b"), item("c", true)], unread: 2});
  await useInboxStore.getState().load();
  api.read.mockResolvedValue({unread: 1});
  await useInboxStore.getState().open(useInboxStore.getState().items[0]);
  expect(api.read).toHaveBeenCalledWith("a");
  expect(useInboxStore.getState().unread).toBe(1);
  expect(useInboxStore.getState().items[0].read_at).not.toBeNull();
  expect(openChannelLink).toHaveBeenCalledWith("star", "room");
  // Прочитанное ещё раз не уменьшает счётчик.
  api.read.mockResolvedValue({unread: 1});
  await useInboxStore.getState().markRead("a");
  expect(useInboxStore.getState().unread).toBe(1);
});

it("follows reads made on another device", async () => {
  api.list.mockResolvedValue({items: [item("a"), item("b")], unread: 2});
  await useInboxStore.getState().load();
  emit({type: "inbox_read", ids: ["b"], unread: 1});
  expect(useInboxStore.getState().items.find((i) => i.id === "b")!.read_at).not.toBeNull();
  emit({type: "inbox_read", ids: null, unread: 0});
  expect(useInboxStore.getState().items.every((i) => i.read_at)).toBe(true);
  expect(useInboxStore.getState().unread).toBe(0);
});

it("drops notifications the server cleaned up after ten days", async () => {
  api.list.mockResolvedValue({items: [item("a"), item("b")], unread: 2});
  await useInboxStore.getState().load();
  emit({type: "inbox_removed", ids: ["a"], unread: 1});
  expect(useInboxStore.getState().items.map((i) => i.id)).toEqual(["b"]);
  expect(useInboxStore.getState().unread).toBe(1);
});

import {beforeEach, expect, it, vi} from "vitest";

const events = vi.hoisted(() => ({messages: [] as Array<(event: any) => void>, status: [] as Array<(open: boolean) => void>}));
vi.mock("../../ws/socket", () => ({socket: {on: (fn: (event: any) => void) => events.messages.push(fn), onStatus: (fn: (open: boolean) => void) => events.status.push(fn)}}));
vi.mock("../../api/client", () => ({http: {get: vi.fn(), put: vi.fn()}}));
const {http} = await import("../../api/client");
const {useNotifyStore, channelLevel} = await import("../levels");
const muted = {scope: "channel" as const, target_id: "channel", level: "none" as const, muted_until: null};
beforeEach(() => {vi.clearAllMocks(); useNotifyStore.getState().reset();});

it("does not overwrite a fresh websocket preference with an older GET response", async () => {
  let finish!: (value: any) => void;
  vi.mocked(http.get).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const pending = useNotifyStore.getState().load();
  events.messages[0]({type: "notify_setting", ...muted});
  finish({data: []}); await pending;
  expect(channelLevel(useNotifyStore.getState().settings, "star", "channel")).toBe("none");
});

it("discards an old account's late settings response after reset", async () => {
  let finish!: (value: any) => void;
  vi.mocked(http.get).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const pending = useNotifyStore.getState().load(); useNotifyStore.getState().reset();
  finish({data: [muted]}); await pending;
  expect(useNotifyStore.getState().settings).toEqual({});
  expect(useNotifyStore.getState().loaded).toBe(false);
});

it("shares the initial load and refreshes preferences on reconnect", async () => {
  vi.mocked(http.get).mockResolvedValueOnce({data: [muted]});
  const first = useNotifyStore.getState().load(), second = useNotifyStore.getState().load();
  expect(first).toBe(second); await first;
  vi.mocked(http.get).mockResolvedValueOnce({data: []});
  events.status[0](true); await useNotifyStore.getState().load();
  expect(useNotifyStore.getState().settings).toEqual({});
  expect(http.get).toHaveBeenCalledTimes(2);
});

it("preserves the explicitly chosen legacy combined mode", async () => {
  vi.mocked(http.get).mockResolvedValueOnce({data: [{...muted, level: "mentions"}]});
  await useNotifyStore.getState().load();
  expect(channelLevel(useNotifyStore.getState().settings, "star", "channel")).toBe("mentions");
});

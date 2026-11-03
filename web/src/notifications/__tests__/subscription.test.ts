import {afterEach, beforeEach, expect, it, vi} from "vitest";

vi.mock("../../api/client", () => ({http: {get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: {headers: {common: {Authorization: "Bearer old"}}}}}));
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value)});
const {http} = await import("../../api/client");
const {ensurePushSubscription, dropPushSubscription} = await import("../push");
let permission: string, stored: any;
let subscription: any;
let subscribe: ReturnType<typeof vi.fn>, requestPermission: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  memory.clear(); permission = "granted";
  vi.stubGlobal("localStorage", {getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value)});
  vi.stubGlobal("PushManager", class {});
  requestPermission = vi.fn();
  vi.stubGlobal("Notification", {get permission() {return permission;}, requestPermission});
  subscription = {endpoint: "https://push.example/device", options: {applicationServerKey: new Uint8Array([1, 2, 3]).buffer},
    toJSON: () => ({endpoint: "https://push.example/device", keys: {p256dh: "public-key", auth: "auth-key"}}),
    unsubscribe: vi.fn(async () => {stored = null; return true;})};
  stored = subscription;
  subscribe = vi.fn(async () => {stored = subscription; return subscription;});
  const reg = {active: {}, pushManager: {getSubscription: vi.fn(async () => stored), subscribe}};
  vi.stubGlobal("navigator", {serviceWorker: {getRegistration: vi.fn().mockResolvedValue(reg), ready: Promise.resolve(reg)}, userAgent: "test"});
  vi.mocked(http.get).mockResolvedValue({data: {configured: true, publicKey: "AQID"}});
  vi.mocked(http.post).mockResolvedValue({data: {ok: true}});
  vi.mocked(http.delete).mockResolvedValue({data: {ok: true}});
  http.defaults.headers.common.Authorization = "Bearer old";
  await dropPushSubscription(); stored = subscription;
  vi.clearAllMocks();
});
afterEach(async () => {await dropPushSubscription(); vi.unstubAllGlobals();});

it("binds the existing subscription to the account and synchronizes device preferences", async () => {
  memory.set("quazar-notify-prefs", JSON.stringify({enabled: false, sound: false}));
  expect(await ensurePushSubscription()).toBe(true);
  expect(subscribe).not.toHaveBeenCalled();
  expect(http.post).toHaveBeenCalledWith("/push/subscribe", expect.objectContaining({endpoint: subscription.endpoint, enabled: false, sound: false}));
});

it("does not request browser permission from background startup effects", async () => {
  permission = "default";
  expect(await ensurePushSubscription()).toBe(false);
  expect(requestPermission).not.toHaveBeenCalled();
  expect(http.get).not.toHaveBeenCalled();
});

it("re-subscribes when the VAPID application key changed", async () => {
  subscription.options.applicationServerKey = new Uint8Array([4, 5, 6]).buffer;
  expect(await ensurePushSubscription()).toBe(true);
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({userVisibleOnly: true}));
});

it("serializes simultaneous subscription requests", async () => {
  const first = ensurePushSubscription(), second = ensurePushSubscription();
  expect(first).toBe(second);
  await first;
  expect(http.post).toHaveBeenCalledOnce();
});

it("unsubscribes on logout using the captured old credentials", async () => {
  await ensurePushSubscription();
  const pending = dropPushSubscription();
  http.defaults.headers.common.Authorization = "Bearer next-account";
  await pending;
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(http.delete).toHaveBeenCalledWith("/push/subscribe", expect.objectContaining({data: {endpoint: subscription.endpoint}, headers: {Authorization: "Bearer old"}}));
});

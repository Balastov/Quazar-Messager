import { AxiosError, type AxiosResponse } from "axios";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Проверка сохранённой сессии при запуске: выходим только когда сервер сказал «сессия завершена».
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
const me = vi.fn();
const connect = vi.fn();
const stub = (extra: Record<string, unknown> = {}) => ({ getState: () => ({ reset: vi.fn(), ...extra }) });

vi.mock("../../api/users", () => ({ usersApi: { me } }));
vi.mock("../../api/client", () => ({
  http: { interceptors: { response: { use: vi.fn() } }, delete: vi.fn(() => Promise.resolve()), defaults: { headers: { common: {} } } },
  setAuthToken: vi.fn(),
}));
vi.mock("../../ws/socket", () => ({ socket: { connect, disconnect: vi.fn(), on: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}) } }));
vi.mock("../../notifications/push", () => ({ ensurePushSubscription: vi.fn(), dropPushSubscription: vi.fn() }));
vi.mock("../../notifications/delivery", () => ({ setNotificationUser: vi.fn() }));
vi.mock("../e2e", () => ({ useE2EStore: stub({ sync: vi.fn() }) }));
vi.mock("../stars", () => ({ useStarsStore: stub() }));
vi.mock("../../notifications/levels", () => ({ useNotifyStore: stub() }));
vi.mock("../admin", () => ({ useAdminStore: stub() }));
vi.mock("../voice", () => ({ useVoiceStore: stub({ leave: vi.fn() }) }));
vi.mock("../doors", () => ({ useDoorsStore: stub() }));
vi.mock("../wallpaper", () => ({ useWallpaperStore: stub({ load: vi.fn() }) }));
vi.mock("../unread", () => ({ useUnreadStore: stub({ replace: vi.fn() }) }));
vi.mock("../call", () => ({ useCallStore: stub({ hangup: vi.fn() }) }));

const user = { id: "u1", username: "Capitan" };

function failure(status?: number) {
  return new AxiosError(status ? "Request failed" : "Network Error", status ? "ERR_BAD_RESPONSE" : "ERR_NETWORK", undefined, undefined,
    status ? ({ status, data: {} } as AxiosResponse) : undefined);
}

async function start() {
  localStorage.setItem("quazar-auth", JSON.stringify({ state: { token: "t1", user }, version: 0 }));
  const { useAuthStore } = await import("../auth");
  await vi.advanceTimersByTimeAsync(0);
  return useAuthStore;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  me.mockReset();
  connect.mockReset();
  memory.clear();
});
afterEach(() => vi.useRealTimers());

it("stays signed in without a connection and connects once the server answers", async () => {
  me.mockRejectedValueOnce(failure()).mockRejectedValueOnce(failure(502)).mockResolvedValue(user);
  const store = await start();
  expect(store.getState().token).toBe("t1");
  expect(store.getState().user).toEqual(user);
  expect(connect).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(2000);
  expect(store.getState().token).toBe("t1");
  expect(me).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(5000);
  expect(me).toHaveBeenCalledTimes(3);
  expect(store.getState().token).toBe("t1");
  expect(connect).toHaveBeenCalledWith("t1");

  await vi.advanceTimersByTimeAsync(60_000);
  expect(me).toHaveBeenCalledTimes(3);
});

it("checks again right away when the network comes back", async () => {
  me.mockRejectedValueOnce(failure()).mockResolvedValue(user);
  const store = await start();
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(me).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenCalledWith("t1");
  expect(store.getState().token).toBe("t1");
});

it("signs out when the server says the session has ended", async () => {
  me.mockRejectedValue(failure(401));
  const store = await start();
  expect(store.getState().token).toBeNull();
  expect(store.getState().user).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(me).toHaveBeenCalledTimes(1);
});

it("stops retrying after the user signs out by hand", async () => {
  me.mockRejectedValue(failure());
  const store = await start();
  store.getState().logout();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(me).toHaveBeenCalledTimes(1);
});

it("tells the server why the app signed out", async () => {
  const { http } = await import("../../api/client");
  me.mockRejectedValue(failure(401));
  await start();
  // Сессию сервер уже отверг: в журнал входов уходит «rejected» и запрос, получивший 401.
  expect(http.delete).toHaveBeenLastCalledWith("/auth/devices/current", expect.objectContaining({
    headers: { Authorization: "Bearer t1" }, params: { reason: "rejected", source: "GET /users/me" } }));
});

it("passes the reason of a manual sign-out", async () => {
  const { http } = await import("../../api/client");
  me.mockResolvedValue(user);
  const store = await start();
  store.getState().logout("button");
  expect(http.delete).toHaveBeenLastCalledWith("/auth/devices/current", expect.objectContaining({ params: { reason: "button" } }));
});

it("names the request whose 401 made the app sign out", async () => {
  const { http } = await import("../../api/client");
  me.mockResolvedValue(user);
  await start();
  const calls = vi.mocked(http.interceptors.response.use).mock.calls;
  const onError = calls[calls.length - 1][1] as (err: unknown) => Promise<unknown>;
  const err = failure(401);
  err.config = { method: "post", url: "/auth/device-pairing/invites/x/accept?y=1", headers: { Authorization: "Bearer t1" } } as never;
  (http.defaults.headers.common as Record<string, string>)["Authorization"] = "Bearer t1";
  await onError(err).catch(() => {});
  expect(http.delete).toHaveBeenLastCalledWith("/auth/devices/current", expect.objectContaining({
    params: { reason: "rejected", source: "POST /auth/device-pairing/invites/x/accept" } }));
});

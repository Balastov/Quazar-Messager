import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), post: vi.fn(), get: vi.fn(), ring: vi.fn(), stop: vi.fn(), resume: vi.fn(), bridge: null as any,
  handlers: new Set<(event: any) => void>() }));
vi.mock("../../api/client", () => ({ http: { post: mocks.post, get: mocks.get } }));
vi.mock("../../store/auth", () => { const store: any = (selector: any) => selector({ user: { id: "alice" } }); store.getState = () => ({ user: { id: "alice" } }); return { useAuthStore: store }; });
vi.mock("../../store/call", () => ({ useCallStore: (selector: any) => selector({ phase: "idle" }) }));
vi.mock("../../store/voice", () => ({ useVoiceStore: (selector: any) => selector({ status: "idle" }) }));
vi.mock("../../platform/desktop", () => ({ desktop: () => mocks.bridge }));
vi.mock("../../notifications/connectionCheck", () => ({ prepareNotificationCheck: mocks.prepare, CHECK_ERRORS: { transport_error: "Сервис недоступен" }, notificationHelp: () => "Проверьте разрешения и режим Не беспокоить" }));
vi.mock("../../notifications/sound", () => ({ getCtx: () => ({ resume: mocks.resume }), startCallRingtone: mocks.ring }));
vi.mock("../../notifications/push", () => ({ dropPushSubscription: vi.fn().mockResolvedValue(undefined), ensurePushSubscription: vi.fn().mockResolvedValue(true) }));
vi.mock("../../ws/socket", () => ({ socket: { on: (handler: any) => { mocks.handlers.add(handler); return () => mocks.handlers.delete(handler); } } }));
vi.mock("../MicCheck", () => ({ default: () => createElement("span", null, "Тест микрофона") }));
import ConnectionDiagnostics from "../ConnectionDiagnostics";
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks(); mocks.bridge = null; mocks.handlers.clear();
  mocks.prepare.mockResolvedValue({ transport: "push", endpoint: "https://fcm.googleapis.com/own" });
  mocks.post.mockImplementation(async (_path, body) => ({ data: { id: body.id, state: "queued", error_code: null, expires_at: "2030-01-01" } }));
  mocks.get.mockResolvedValue({ data: { id: "test", state: "displayed", error_code: null, expires_at: "2030-01-01" } });
  mocks.ring.mockReturnValue(mocks.stop); mocks.resume.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
async function open() { await act(async () => root.render(createElement(ConnectionDiagnostics))); await click("Проверить связь"); }
it("does not request notification delivery, microphone or sound on opening settings", async () => {
  await open(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.ring).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});
it("distinguishes device receipt from the user's visual confirmation", async () => {
  await open(); await click("Отправить тестовое уведомление");
  expect(mocks.post).toHaveBeenCalledWith("/push/diagnostics", expect.objectContaining({ transport: "push", endpoint: "https://fcm.googleapis.com/own" }), expect.any(Object));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(host.textContent).toContain("передачу уведомления системе"); expect(host.textContent).not.toContain("Вы подтвердили получение");
  await click("Уведомление пришло"); expect(host.textContent).toContain("Вы подтвердили получение");
});
it("does not claim success when transport fails and provides instructions", async () => {
  mocks.get.mockResolvedValue({ data: { id: "test", state: "failed", error_code: "transport_error" } });
  await open(); await click("Отправить тестовое уведомление"); await act(async () => vi.advanceTimersByTime(1000));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Сервис недоступен");
  expect(host.textContent).not.toContain("Вы подтвердили получение");
  await click("Не вижу уведомления"); expect(host.textContent).toContain("Проверьте разрешения");
});
it("stops ringtone playback and polling when the panel closes", async () => {
  await open(); await click("Послушать звонок"); await click("Отправить тестовое уведомление");
  await click("Закрыть проверку связи"); await act(async () => vi.advanceTimersByTime(5000));
  expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.get).not.toHaveBeenCalled();
});
it("only shows the matching desktop probe and acknowledges after native notification succeeds", async () => {
  mocks.bridge = { showNotification: vi.fn().mockResolvedValue(true) }; mocks.prepare.mockResolvedValue({ transport: "desktop" });
  await open(); await click("Отправить тестовое уведомление");
  const id = mocks.post.mock.calls[0][1].id;
  const event = { type: "connection_test", test_id: id, receipt_secret: "secret", recipient_user_id: "alice", title: "Проверка", body: "Тест" };
  await act(async () => { mocks.handlers.forEach(handler => handler({ ...event, test_id: "other" })); });
  expect(mocks.bridge.showNotification).not.toHaveBeenCalled();
  await act(async () => { mocks.handlers.forEach(handler => handler(event)); });
  expect(mocks.bridge.showNotification).toHaveBeenCalledOnce();
  expect(mocks.post).toHaveBeenCalledWith(`/push/diagnostics/${id}/receipt`, { secret: "secret" }, expect.any(Object));
});
it("does not issue a late probe after closing during preparation", async () => {
  let finish!: (value: any) => void; mocks.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await open(); await click("Отправить тестовое уведомление"); await click("Закрыть проверку связи");
  await act(async () => finish({ transport: "push", endpoint: "https://fcm.googleapis.com/own" }));
  expect(mocks.post).not.toHaveBeenCalled();
});

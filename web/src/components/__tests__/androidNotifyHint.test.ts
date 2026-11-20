import {act, createElement} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
vi.mock("../../ws/socket", () => ({socket: {on: () => () => {}, onStatus: () => () => {}, waitUntilOpen: async () => true}}));
vi.mock("../ConnectionDiagnostics", () => ({default: () => null}));
const {default: NotificationsSection} = await import("../settings/NotificationsSection");
const {notificationHelp, prepareNotificationCheck} = await import("../../notifications/connectionCheck");
const {ANDROID_NOTIFY_HINT} = await import("../../platform/android");

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Во встроенном браузере Android нет Notification — как и в jsdom.
  vi.stubGlobal("Notification", undefined);
  const stored = new Map([["quazar-notify-prefs", JSON.stringify({enabled: true, sound: false, promptDismissed: true})]]);
  vi.stubGlobal("localStorage", {getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k)});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  delete (window as {Capacitor?: unknown}).Capacitor;
});
const android = () => { (window as {Capacitor?: unknown}).Capacitor = {getPlatform: () => "android", Plugins: {}}; };

it("explains in the Android app where notifications work instead of blaming the browser", async () => {
  android();
  await act(async () => root.render(createElement(NotificationsSection)));
  expect(host.textContent).toContain(ANDROID_NOTIFY_HINT);
  expect(host.textContent).not.toContain("Браузер не поддерживает уведомления");
  expect(notificationHelp()).toBe(ANDROID_NOTIFY_HINT);
  await expect(prepareNotificationCheck()).rejects.toThrow(ANDROID_NOTIFY_HINT);
});

it("keeps the browser status outside the Android app", async () => {
  await act(async () => root.render(createElement(NotificationsSection)));
  expect(host.textContent).toContain("Браузер не поддерживает уведомления");
  expect(host.textContent).not.toContain(ANDROID_NOTIFY_HINT);
  expect(notificationHelp()).not.toBe(ANDROID_NOTIFY_HINT);
});

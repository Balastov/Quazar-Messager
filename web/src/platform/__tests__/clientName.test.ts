import { afterEach, expect, it } from "vitest";
import { clientName } from "../clientName";

const win = window as unknown as { quazarDesktop?: unknown; Capacitor?: unknown };
afterEach(() => { delete win.quazarDesktop; delete win.Capacitor; });

it("names the app for the sign-in log", () => {
  expect(clientName()).toBe("web");
  win.Capacitor = { getPlatform: () => "android" };
  expect(clientName()).toBe("android");
  win.Capacitor = { getPlatform: () => "ios" };
  expect(clientName()).toBe("ios");
  win.quazarDesktop = { version: "2.8.0" };
  expect(clientName()).toBe("desktop/2.8.0");
});

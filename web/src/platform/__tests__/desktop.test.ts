import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop, publicOrigin, type DesktopBridge, type DesktopUpdate } from "../desktop";
import DesktopUpdates from "../../components/DesktopUpdates";
import { desktopYandexParams, desktopYandexVerifier, startDesktopYandexLogin } from "../../auth/desktopYandex";

let host: HTMLDivElement, root: Root;
let update: (state: DesktopUpdate) => void;
const bridge = {
  platform: "win32", version: "0.19.2", serverOrigin: "https://quazar-msg.ru",
  updateState: vi.fn(), onUpdate: vi.fn((callback: typeof update) => { update = callback; return vi.fn(); }),
  installUpdate: vi.fn(), openAuth: vi.fn(),
} as unknown as DesktopBridge;
beforeEach(() => {
  vi.clearAllMocks();
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value), removeItem: (key: string) => void memory.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  delete window.quazarDesktop;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(bridge.updateState).mockResolvedValue({ status: "idle", currentVersion: "0.19.2", manual: false });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.quazarDesktop; vi.unstubAllGlobals(); });
it("keeps web builds free of desktop UI and uses the real server for desktop public links", async () => {
  expect(desktop()).toBeUndefined();
  expect(publicOrigin()).toBe(window.location.origin);
  await act(async () => root.render(createElement(DesktopUpdates)));
  expect(host.textContent).toBe("");
  expect(bridge.updateState).not.toHaveBeenCalled();
  window.quazarDesktop = bridge;
  expect(publicOrigin()).toBe("https://quazar-msg.ru");
});
it("does not install a downloaded update until requested and explains an active-call refusal", async () => {
  window.quazarDesktop = bridge;
  vi.mocked(bridge.installUpdate).mockResolvedValue({ ok: false, reason: "Сначала завершите звонок" });
  await act(async () => root.render(createElement(DesktopUpdates)));
  await act(async () => update({ status: "downloaded", version: "0.20.0", currentVersion: "0.19.2", manual: false }));
  expect(bridge.installUpdate).not.toHaveBeenCalled();
  const install = [...host.querySelectorAll("button")].find(el => el.textContent === "Установить и перезапустить")!;
  await act(async () => install.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("завершите звонок");
});
it("offers manual download for Mac instead of promising an unsigned automatic install", async () => {
  window.quazarDesktop = bridge;
  await act(async () => root.render(createElement(DesktopUpdates)));
  await act(async () => update({ status: "available", version: "0.20.0", currentVersion: "0.19.2", manual: true }));
  expect(host.textContent).toContain("Скачать для Mac");
  expect(host.textContent).not.toContain("Установить и перезапустить");
});
it("sends a challenge to the system browser while the verifier stays in this app", async () => {
  window.quazarDesktop = bridge;
  await startDesktopYandexLogin();
  const url = new URL(vi.mocked(bridge.openAuth).mock.calls[0][0]);
  expect(url.origin).toBe("https://quazar-msg.ru");
  expect(url.searchParams.get("client")).toBe("desktop");
  expect(url.searchParams.get("challenge")).toMatch(/^[\w-]{43}$/);
  const verifier = desktopYandexVerifier()!;
  expect(verifier).toHaveLength(43);
  expect(url.href).not.toContain(verifier);
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const expected = btoa(String.fromCharCode(...hashed)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(url.searchParams.get("challenge")).toBe(expected);
});
it("does not add desktop OAuth parameters to the normal website", async () => {
  expect(await desktopYandexParams()).toEqual({});
  expect(desktopYandexVerifier()).toBeUndefined();
});

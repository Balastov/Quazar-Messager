import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AppVersion from "../AppVersion";
import type { DesktopBridge, DesktopUpdate } from "../../platform/desktop";
import { DesktopDownloadContext } from "../DesktopDownloadContext";
import type { DownloadOS } from "../../platform/desktopDownloads";
import { version } from "../../../package.json";
import { DESKTOP_LAUNCH_URL, DESKTOP_LAUNCH_WAIT, navigateDesktop } from "../../platform/launchDesktop";
import { DESKTOP_RELEASE_POLL_INTERVAL } from "../../platform/desktopReleases";

const [major, minor, patch] = version.split(".").map(Number);
const newerVersion = `${major}.${minor}.${patch + 1}`;

vi.mock("../../platform/launchDesktop", async importOriginal => {
  const original = await importOriginal<typeof import("../../platform/launchDesktop")>();
  const navigate = vi.fn();
  return { ...original, navigateDesktop: navigate, tryLaunchDesktop: (fallback: () => void, external: () => void) => original.tryLaunchDesktop(fallback, external, navigate) };
});

let host: HTMLDivElement, root: Root;
let update: (state: DesktopUpdate) => void;
const off = vi.fn();
const bridge = {
  version: "0.20.1", platform: "win32", serverOrigin: "https://quazar-msg.ru",
  updateState: vi.fn(), onUpdate: vi.fn((callback: typeof update) => { update = callback; return off; }),
  installUpdate: vi.fn(),
} as unknown as DesktopBridge;
const render = () => act(async () => root.render(createElement(AppVersion)));
const emit = (patch: Partial<DesktopUpdate>) => act(async () => update({ status: "available", version: "0.20.3", currentVersion: bridge.version, manual: false, ...patch }));

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`version: ${newerVersion}\npath: ignored.exe\n`)));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  window.quazarDesktop = bridge;
  vi.mocked(bridge.updateState).mockResolvedValue({ status: "idle", currentVersion: bridge.version, manual: false });
  vi.mocked(bridge.installUpdate).mockResolvedValue({ ok: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.quazarDesktop; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows the installed version and keeps the update action hidden until an update exists", async () => {
  await render();
  expect(host.textContent).toBe(bridge.version);
  expect(host.querySelector("button")).toBeNull();
  await emit({ status: "up-to-date", version: undefined });
  expect(host.querySelector("button")).toBeNull();
});

it.each(["0.20.1", "0.20.0", "invalid"])("hides an action for an equal, older or invalid candidate %s", async version => {
  await render(); await emit({ version, status: "downloaded" });
  expect(host.querySelector("button")).toBeNull();
});

it("waits for the Windows download, then updates only after a click", async () => {
  await render(); await emit({ status: "downloading", progress: 42 });
  expect(host.querySelector("button")?.textContent).toBe("Обновить");
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Загрузка: 42%");
  expect(bridge.installUpdate).not.toHaveBeenCalled();
  await emit({ status: "downloaded" });
  expect(host.querySelector("button")?.disabled).toBe(false);
  await act(async () => host.querySelector("button")!.click());
  expect(bridge.installUpdate).toHaveBeenCalledOnce();
});

it("keeps an active-call refusal visible and allows retrying later", async () => {
  vi.mocked(bridge.installUpdate).mockResolvedValue({ ok: false, reason: "Сначала завершите звонок" });
  await render(); await emit({ status: "downloaded" });
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("завершите звонок");
  expect(host.querySelector("button")?.disabled).toBe(false);
});

it("opens the native manual Mac installer action", async () => {
  await render(); await emit({ manual: true });
  expect(host.querySelector("button")?.disabled).toBe(false);
  expect(host.textContent).toContain("Установка вручную");
  expect(host.querySelector("button")?.title).toContain("Mac");
  await act(async () => host.querySelector("button")!.click());
  expect(bridge.installUpdate).toHaveBeenCalledOnce();
});

it("does not let a late initial snapshot hide a newer update event", async () => {
  let resolve!: (state: DesktopUpdate) => void;
  vi.mocked(bridge.updateState).mockReturnValue(new Promise(done => { resolve = done; }));
  await render(); await emit({ status: "downloaded" });
  await act(async () => resolve({ status: "idle", currentVersion: bridge.version, manual: false }));
  expect(host.querySelector("button")?.disabled).toBe(false);
  await act(async () => root.render(null));
  expect(off).toHaveBeenCalledOnce();
});

const renderWeb = async (os: DownloadOS) => {
  delete window.quazarDesktop;
  const context = { os, open: vi.fn(), downloaded: vi.fn() };
  await act(async () => root.render(createElement(DesktopDownloadContext.Provider, { value: context, children: createElement(AppVersion) })));
  return context;
};

it("tries the installed app first and falls back to the newest Windows installer", async () => {
  await renderWeb("windows");
  const download = host.querySelector("button")!;
  expect(host.firstElementChild?.textContent).toBe(version);
  expect(host.firstElementChild?.nextElementSibling).toBe(download);
  expect(download.textContent).toBe("Скачать");
  await act(async () => download.click());
  expect(navigateDesktop).toHaveBeenCalledExactlyOnceWith(DESKTOP_LAUNCH_URL);
  await act(async () => vi.advanceTimersByTimeAsync(DESKTOP_LAUNCH_WAIT));
  expect(navigateDesktop).toHaveBeenLastCalledWith(`/desktop-updates/win-x64/Quazar-${newerVersion}-win-x64.exe`);
  expect(document.querySelector<HTMLAnchorElement>('[role="dialog"] a')?.getAttribute("href")).toBe(`/desktop-updates/win-x64/Quazar-${newerVersion}-win-x64.exe`);
  expect(bridge.updateState).not.toHaveBeenCalled();
});

it("offers both Mac architectures from the current published release", async () => {
  await renderWeb("mac");
  expect(host.querySelector("button")?.textContent).toBe("Скачать");
  await act(async () => host.querySelector("button")!.click());
  await act(async () => vi.advanceTimersByTimeAsync(DESKTOP_LAUNCH_WAIT));
  expect(navigateDesktop).toHaveBeenCalledExactlyOnceWith(DESKTOP_LAUNCH_URL);
  const links = [...document.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')];
  expect(links.map(link => link.getAttribute("href"))).toEqual([
    `/desktop-updates/mac-arm64/Quazar-${newerVersion}-mac-arm64.dmg`, `/desktop-updates/mac-x64/Quazar-${newerVersion}-mac-x64.dmg`,
  ]);
});

it.each(["mobile", "other"] as const)("does not promise a supported installer below the version on %s", async os => {
  await renderWeb(os);
  expect(host.textContent).toBe(version);
  expect(host.querySelector("button, a")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([version, "0.19.0"])("does not show web download for a desktop release %s that is not newer than the website", async candidate => {
  vi.mocked(fetch).mockImplementation(async () => new Response(`version: ${candidate}\n`));
  await renderWeb("windows");
  expect(host.querySelector("button")).toBeNull();
});

it("discovers a newly published build while the same web page remains open", async () => {
  let candidate = version;
  vi.mocked(fetch).mockImplementation(async () => new Response(`version: ${candidate}\n`));
  await renderWeb("windows");
  expect(host.querySelector("button")).toBeNull();
  candidate = newerVersion;
  await act(async () => vi.advanceTimersByTimeAsync(DESKTOP_RELEASE_POLL_INTERVAL));
  expect(host.querySelector("button")?.textContent).toBe("Скачать");
  expect(host.firstElementChild?.textContent).toBe(version);
});

it("cancels automatic download if focus leaves for the app or the browser permission prompt", async () => {
  await renderWeb("windows");
  await act(async () => host.querySelector("button")!.click());
  await act(async () => window.dispatchEvent(new Event("blur")));
  await act(async () => vi.advanceTimersByTimeAsync(DESKTOP_LAUNCH_WAIT));
  expect(navigateDesktop).toHaveBeenCalledExactlyOnceWith(DESKTOP_LAUNCH_URL);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Если Quazar открылся");
  expect(document.querySelector('[role="dialog"] a')).not.toBeNull();
});

it("cancels a pending fallback when the launch dialog is closed", async () => {
  await renderWeb("windows");
  await act(async () => host.querySelector("button")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Закрыть"]')!.click());
  await act(async () => vi.advanceTimersByTimeAsync(DESKTOP_LAUNCH_WAIT));
  expect(navigateDesktop).toHaveBeenCalledExactlyOnceWith(DESKTOP_LAUNCH_URL);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("does not advertise a new version if its metadata cannot be loaded", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  await renderWeb("windows");
  expect(host.querySelector("button")).toBeNull();
});

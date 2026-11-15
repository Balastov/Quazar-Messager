import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AndroidUpdates from "../AndroidUpdates";
import Quiet from "../Quiet";
import { androidShell, parseAndroidRelease, type AndroidUpdater } from "../../platform/android";
import { androidApkUrl } from "../../platform/desktopDownloads";

const SHA = "a".repeat(64);
const ORIGIN = "https://quazar-msg.ru";
const release = { version: "1.3.0", versionCode: 10300, url: `${ORIGIN}/desktop-updates/android/Quazar-1.3.0-android.apk`, sha256: SHA };

let host: HTMLDivElement;
let root: Root;

function shell(patch: Partial<AndroidUpdater> = {}): AndroidUpdater {
  return {
    info: vi.fn().mockResolvedValue({ versionName: "1.2.0", versionCode: 10200, canInstall: true }),
    install: vi.fn().mockResolvedValue(undefined),
    allowInstalls: vi.fn().mockResolvedValue(undefined),
    // Голый мост Capacitor отдаёт подписку сразу, не обещанием.
    addListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
    ...patch,
  };
}

function install(updater: AndroidUpdater | null, feed: unknown = release) {
  vi.stubGlobal("Capacitor", updater ? { getPlatform: () => "android", Plugins: { QuazarUpdater: updater } } : undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => feed }));
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const render = async () => {
  await act(async () => root.render(createElement(Quiet, null, createElement(AndroidUpdates))));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("android update feed", () => {
  it("accepts only a complete release from the same server", () => {
    expect(parseAndroidRelease(release, ORIGIN)).toEqual(release);
    expect(parseAndroidRelease({ ...release, url: "https://evil.example/desktop-updates/android/x.apk" }, ORIGIN)).toBeNull();
    expect(parseAndroidRelease({ ...release, url: `${ORIGIN}/desktop-updates/android/../x.apk` }, ORIGIN)).toBeNull();
    expect(parseAndroidRelease({ ...release, sha256: "short" }, ORIGIN)).toBeNull();
    expect(parseAndroidRelease({ ...release, versionCode: 0 }, ORIGIN)).toBeNull();
    expect(parseAndroidRelease({ ...release, version: "latest" }, ORIGIN)).toBeNull();
    expect(parseAndroidRelease(null, ORIGIN)).toBeNull();
  });

  it("links the site download to the update folder", () => {
    expect(androidApkUrl({ version: "1.3.0" })).toBe(release.url);
  });

  it("finds the updater only inside the Android app", () => {
    vi.stubGlobal("Capacitor", undefined);
    expect(androidShell()).toBeUndefined();
    vi.stubGlobal("Capacitor", { getPlatform: () => "web", Plugins: {} });
    expect(androidShell()).toBeUndefined();
  });
});

describe("android update banner", () => {
  it("offers a newer version and installs it", async () => {
    const updater = shell();
    install(updater, { ...release, url: `${window.location.origin}/desktop-updates/android/Quazar-1.3.0-android.apk` });
    await render();
    expect(host.textContent).toContain("Доступна версия 1.3.0 для Android");
    await act(async () => button("Обновить")!.click());
    expect(updater.install).toHaveBeenCalledWith(expect.objectContaining({ sha256: SHA, versionCode: 10300 }));
  });

  it("asks to allow installs first", async () => {
    const updater = shell({ info: vi.fn().mockResolvedValue({ versionName: "1.2.0", versionCode: 10200, canInstall: false }) });
    install(updater, { ...release, url: `${window.location.origin}/desktop-updates/android/Quazar-1.3.0-android.apk` });
    await render();
    expect(button("Обновить")).toBeUndefined();
    await act(async () => button("Разрешить установку")!.click());
    expect(updater.allowInstalls).toHaveBeenCalled();
  });

  it("stays quiet when the app is current, outside the app, or on a broken bridge", async () => {
    install(shell({ info: vi.fn().mockResolvedValue({ versionName: "1.3.0", versionCode: 10300, canInstall: true }) }),
      { ...release, url: `${window.location.origin}/desktop-updates/android/Quazar-1.3.0-android.apk` });
    await render();
    expect(host.textContent).toBe("");

    install(null);
    await render();
    expect(host.textContent).toBe("");

    // Сбой моста не роняет остальной интерфейс.
    vi.spyOn(console, "error").mockImplementation(() => {});
    install(shell({ addListener: vi.fn(() => { throw new Error("bridge"); }) }),
      { ...release, url: `${window.location.origin}/desktop-updates/android/Quazar-1.3.0-android.apk` });
    await render();
    expect(host.textContent).toContain("Доступна версия 1.3.0");
  });

  it("shows the installer error", async () => {
    const updater = shell({ install: vi.fn().mockRejectedValue(new Error("Обновление подписано другим ключом — установка отменена")) });
    install(updater, { ...release, url: `${window.location.origin}/desktop-updates/android/Quazar-1.3.0-android.apk` });
    await render();
    await act(async () => button("Обновить")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("другим ключом");
  });
});

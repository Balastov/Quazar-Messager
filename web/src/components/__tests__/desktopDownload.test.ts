import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../../platform/desktop";
import { ANDROID_OFFER_DELAY, ANDROID_PROMPT_KEY, ANDROID_RELEASE, DOWNLOAD_OFFER_DELAY, DOWNLOAD_PROMPT_KEY } from "../../platform/desktopDownloads";

const state = vi.hoisted(() => ({ auth: { token: "test-session" as string | null }, call: { phase: "idle" }, voice: { status: "idle" } }));
vi.mock("../../store/auth", () => ({ useAuthStore: (selector: (value: typeof state.auth) => unknown) => selector(state.auth) }));
vi.mock("../../store/call", () => ({ useCallStore: (selector: (value: typeof state.call) => unknown) => selector(state.call) }));
vi.mock("../../store/voice", () => ({ useVoiceStore: (selector: (value: typeof state.voice) => unknown) => selector(state.voice) }));
const { DesktopDownloads } = await import("../DesktopDownload");
const { default: DesktopDownloadButton } = await import("../DesktopDownloadButton");

let host: HTMLDivElement, root: Root;
const memory = new Map<string, string>();
const offer = () => document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby]');
const button = (text: string) => {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
};
const preference = () => JSON.parse(memory.get(DOWNLOAD_PROMPT_KEY) ?? "null");
const render = async () => act(async () => root.render(createElement(DesktopDownloads, { children: createElement(DesktopDownloadButton) })));
const tick = async (ms = DOWNLOAD_OFFER_DELAY) => act(async () => vi.advanceTimersByTimeAsync(ms));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T09:00:00Z")); memory.clear();
  state.auth.token = "test-session"; state.call.phase = "idle"; state.voice.status = "idle";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  window.history.replaceState(null, "", "/"); delete window.quazarDesktop;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.quazarDesktop; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps the Windows installer button visible and offers the three answers after a delay", async () => {
  await render();
  expect(host.querySelector("a")?.textContent).toBe("Скачать десктоп версию");
  expect(host.querySelector("a")?.href).toMatch(/-win-x64\.exe$/);
  await tick(DOWNLOAD_OFFER_DELAY - 1); expect(offer()).toBeNull();
  await tick(1);
  expect(offer()?.textContent).toContain("Скачать десктоп версию?");
  expect(offer()?.textContent).toContain("Больше не спрашивать");
  expect(offer()?.querySelector("a")?.textContent).toBe("Да");
  expect(button("Позже")).toBeDefined(); expect(button("Не хочу")).toBeDefined();
});

it.each([["Позже", 7], ["Не хочу", 30]] as const)("persists %s and asks again only after its cooldown", async (answer, days) => {
  await render(); await tick(); const now = Date.now();
  await act(async () => button(answer).click());
  expect(offer()).toBeNull();
  expect(preference()).toEqual({ never: false, nextAt: now + days * 86_400_000 });
  await act(async () => root.render(null)); vi.setSystemTime(now + (days - 1) * 86_400_000);
  await render(); await tick(); expect(offer()).toBeNull();
  await act(async () => root.render(null)); vi.setSystemTime(now + days * 86_400_000 + 1);
  await render(); await tick(); expect(offer()).not.toBeNull();
});

it("honors 'do not ask again' while leaving the permanent download button available", async () => {
  await render(); await tick();
  const checkbox = offer()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => { checkbox.checked = true; Simulate.change(checkbox); });
  await act(async () => button("Позже").click());
  expect(preference().never).toBe(true);
  await act(async () => root.render(null)); vi.setSystemTime(Date.now() + 366 * 86_400_000);
  await render(); await tick(); expect(offer()).toBeNull();
  expect(host.querySelector("a")?.textContent).toBe("Скачать десктоп версию");
});

it("accepting downloads the Windows link without leaving the web app and stops future prompts", async () => {
  await render(); await tick();
  const yes = offer()!.querySelector<HTMLAnchorElement>("a")!;
  expect(yes.href).toMatch(/-win-x64\.exe$/); expect(yes.target).toBe("_blank");
  expect(yes.rel).toContain("noopener");
  await act(async () => Simulate.click(yes));
  expect(offer()).toBeNull(); expect(preference().never).toBe(true);
});

it("does not infer an Intel processor from the generic Mac browser platform", async () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 });
  await render(); await tick();
  await act(async () => button("Да").click());
  const dialog = document.querySelector('[role="dialog"][aria-label="Скачать десктоп версию"]')!;
  const links = [...dialog.querySelectorAll("a")];
  expect(links).toHaveLength(2);
  expect(links.map(link => link.href)).toEqual(expect.arrayContaining([expect.stringMatching(/-mac-arm64\.dmg$/), expect.stringMatching(/-mac-x64\.dmg$/)]));
  await act(async () => Simulate.click(links[0]));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(preference().never).toBe(true);
});

it("does not undo a permanent opt-out when manually opening and closing the Mac downloads", async () => {
  memory.set(DOWNLOAD_PROMPT_KEY, JSON.stringify({ never: true, nextAt: 0 }));
  vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel" });
  await render();
  await act(async () => button("Скачать десктоп версию").click());
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')?.checked).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Закрыть"]')!.click());
  expect(preference().never).toBe(true);
});

it("does not advertise inside the desktop client", async () => {
  window.quazarDesktop = {} as DesktopBridge;
  await render(); await tick();
  expect(host.textContent).toBe(""); expect(offer()).toBeNull();
});

it.each([
  { userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile", platform: "Linux armv8l" },
  { userAgent: "reduced", userAgentData: { platform: "Android", mobile: false } },
])("offers the Android app on Android phones without desktop prompts", async browser => {
  vi.stubGlobal("navigator", browser);
  // Автоматическое предложение приложения отключено «Больше не показывать» — остаётся кнопка.
  memory.set(ANDROID_PROMPT_KEY, JSON.stringify({ never: true, nextAt: 0 }));
  await render(); await tick(60_000); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toBe("Скачать мобильное приложение");
  await act(async () => button("Скачать мобильное приложение").click());
  const dialog = document.querySelector('[role="dialog"][aria-label="Quazar для Android"]')!;
  const link = dialog.querySelector("a")!;
  expect(link.href).toMatch(/^https:\/\/quazar-msg\.ru\/desktop-updates\/android\/Quazar-\d+\.\d+\.\d+-android\.apk$/);
  expect(dialog.textContent).toContain("Всё равно установить");
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each([
  { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18)", platform: "iPhone" },
  { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 },
])("shows the mobile placeholder on iPhone and iPad without desktop prompts", async browser => {
  vi.stubGlobal("navigator", browser);
  await render(); await tick(60_000); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toBe("Скачать мобильное приложение");
  await act(async () => button("Скачать мобильное приложение").click());
  const dialog = document.querySelector('[role="dialog"][aria-label="Мобильное приложение"]')!;
  expect(dialog.textContent).toContain("Мобильное приложение почти готово, ожидайте уведомление");
  expect(dialog.querySelectorAll("a")).toHaveLength(0);
  expect(document.activeElement).toBe(button("Понятно"));
  await act(async () => button("Понятно").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(preference()).toBeNull();
});

it("preserves existing desktop preferences when dismissing the mobile notice with Escape", async () => {
  const saved = JSON.stringify({ never: true, nextAt: 123 });
  memory.set(DOWNLOAD_PROMPT_KEY, saved);
  vi.stubGlobal("navigator", { userAgent: "iPhone", platform: "iPhone" });
  await render();
  await act(async () => button("Скачать мобильное приложение").click());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(memory.get(DOWNLOAD_PROMPT_KEY)).toBe(saved);
  await act(async () => button("Скачать мобильное приложение").click());
  expect(button("Понятно")).toBeDefined();
});

it("still offers computer downloads manually on an unsupported desktop OS", async () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" });
  await render(); await tick(60_000); expect(offer()).toBeNull();
  await act(async () => button("Скачать десктоп версию").click());
  expect(document.querySelectorAll('[role="dialog"] a')).toHaveLength(3);
});

it("waits until a conversation ends and hides the offer if a new call arrives", async () => {
  state.call.phase = "active";
  await render(); await tick(60_000); expect(offer()).toBeNull();
  state.call.phase = "idle"; await render(); await tick(); expect(offer()).not.toBeNull();
  state.call.phase = "incoming"; await render();
  expect(offer()).toBeNull(); expect(preference()).toBeNull();
});

it("waits for text editing and other dialogs without taking keyboard focus", async () => {
  await render();
  const input = document.createElement("input"); document.body.append(input); input.focus();
  await tick(); expect(offer()).toBeNull(); input.remove();
  const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
  await tick(15_000); expect(offer()).toBeNull(); dialog.remove();
  const previous = document.activeElement;
  await tick(15_000); expect(offer()).not.toBeNull(); expect(document.activeElement).toBe(previous);
});

it("does not auto-prompt during login or guest access", async () => {
  state.auth.token = null;
  await render(); await tick(60_000); expect(offer()).toBeNull();
  state.auth.token = "test-session"; window.history.replaceState(null, "", "/guest/invite");
  await render(); await tick(); expect(offer()).toBeNull();
});

it("still respects an answer for this page when storage is blocked", async () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  await render(); await tick(); await act(async () => button("Не хочу").click());
  await tick(60_000); expect(offer()).toBeNull();
});

describe("Android", () => {
  const HOURS = 3_600_000;
  const android = () => vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
    platform: "Linux armv8l", maxTouchPoints: 5,
  });
  const androidPreference = () => JSON.parse(memory.get(ANDROID_PROMPT_KEY) ?? "null");
  const reopen = async (at: number) => {
    await act(async () => root.render(null)); vi.setSystemTime(at);
    await render(); await tick(ANDROID_OFFER_DELAY);
  };
  beforeEach(() => android());

  it("offers the app on opening with Download / Not now and a never-again box", async () => {
    await render();
    await tick(ANDROID_OFFER_DELAY - 1); expect(offer()).toBeNull();
    await tick(1);
    expect(offer()?.textContent).toContain("Приложение Quazar для Android");
    expect(offer()?.querySelector("a")?.textContent).toBe("Скачать");
    expect(offer()?.querySelector("a")?.getAttribute("href")).toBe(`https://quazar-msg.ru/desktop-updates/android/Quazar-${ANDROID_RELEASE!.version}-android.apk`);
    expect(button("Не сейчас")).toBeDefined();
    expect(offer()?.textContent).toContain("Больше не показывать");
  });

  it("'Not now' reminds on the next opening, but not before 48 hours", async () => {
    await render(); await tick(ANDROID_OFFER_DELAY); const now = Date.now();
    await act(async () => button("Не сейчас").click());
    expect(offer()).toBeNull();
    expect(androidPreference()).toEqual({ never: false, nextAt: now + 48 * HOURS });
    await reopen(now + 47 * HOURS); expect(offer()).toBeNull();
    await reopen(now + 48 * HOURS + 1); expect(offer()).not.toBeNull();
  });

  it("waits for an opening: 48 hours passing in the middle of a session do not count, a return to the app does", async () => {
    await render(); await tick(ANDROID_OFFER_DELAY); const now = Date.now();
    await act(async () => button("Не сейчас").click());
    vi.setSystemTime(now + 49 * HOURS);
    await tick(60_000); expect(offer()).toBeNull();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await tick(ANDROID_OFFER_DELAY); expect(offer()).not.toBeNull();
  });

  it("'Not now' with the box ticked never asks again", async () => {
    await render(); await tick(ANDROID_OFFER_DELAY);
    const box = offer()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { box.checked = true; Simulate.change(box); });
    await act(async () => button("Не сейчас").click());
    expect(androidPreference()).toMatchObject({ never: true });
    await reopen(Date.now() + 1000 * HOURS); expect(offer()).toBeNull();
  });

  it("Download starts the file, shows how to install and stops offering", async () => {
    await render(); await tick(ANDROID_OFFER_DELAY);
    await act(async () => offer()!.querySelector("a")!.click());
    expect(androidPreference()).toMatchObject({ never: true });
    expect(document.body.textContent).toContain(`Скачиваем Quazar ${ANDROID_RELEASE!.version}`);
    expect(document.body.textContent).toContain("Всё равно установить");
    // Предложение для компьютера не трогаем.
    expect(memory.get(DOWNLOAD_PROMPT_KEY)).toBeUndefined();
    await reopen(Date.now() + 1000 * HOURS);
    expect(document.body.textContent).not.toContain("Приложение Quazar для Android");
  });

  it("stays quiet inside the Android app, during calls and on the sign-in page", async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { getPlatform: () => "android", Plugins: {} };
    await render(); await tick(ANDROID_OFFER_DELAY * 3); expect(offer()).toBeNull();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    await act(async () => root.render(null));

    state.call.phase = "active";
    await render(); await tick(ANDROID_OFFER_DELAY * 3); expect(offer()).toBeNull();
    await act(async () => root.render(null));
    state.call.phase = "idle";

    window.history.replaceState(null, "", "/auth");
    await render(); await tick(ANDROID_OFFER_DELAY * 3); expect(offer()).toBeNull();
    window.history.replaceState(null, "", "/");
    await tick(15_000); expect(offer()).not.toBeNull();
  });
});

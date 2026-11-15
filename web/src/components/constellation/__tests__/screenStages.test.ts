import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScreenStages, { type StageScreen } from "../ScreenStages";
import { screenAudioVolume, sharerAudio, useScreenAudio } from "../../../store/screenAudio";

let host: HTMLDivElement;
let root: Root;
let narrow = false;

function track() {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as NonNullable<StageScreen["screen"]>["track"];
}

function screen(userId: string, name: string, patch: Partial<StageScreen> = {}): StageScreen {
  return { userId, name, isMine: false, pointersEnabled: false,
    screen: { userId, isLocal: false, track: track(), hasAudio: false }, ...patch };
}

function buttonByText(text: string): HTMLButtonElement {
  const el = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`Missing button: ${text}`);
  return el;
}

const labels = () => [...host.querySelectorAll('[class*="screenLabel"]')].map((el) => el.textContent);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  narrow = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("two screen shares", () => {
  const two = [screen("ann", "Анна"), screen("bob", "Борис")];

  it("shows both side by side and lets one be opened large", async () => {
    await act(async () => root.render(createElement(ScreenStages, { screens: two, placeInside: "в Комнате" })));
    expect(buttonByText("Оба рядом").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[class*="screenPairGrid"]')).not.toBeNull();
    expect(labels()).toEqual(["🖥 Анна", "🖥 Борис"]);
    // Каждый показ по-прежнему разворачивается на весь экран своей кнопкой.
    expect(host.querySelectorAll('button[aria-label="На весь экран"]').length).toBe(2);

    await act(async () => buttonByText("🖥 Борис").click());
    expect(labels()).toEqual(["🖥 Борис"]);
    await act(async () => buttonByText("Оба рядом").click());
    expect(labels()).toEqual(["🖥 Анна", "🖥 Борис"]);
  });

  it("puts the pair on the whole screen together", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
    await act(async () => root.render(createElement(ScreenStages, { screens: two, placeInside: "в Комнате" })));
    await act(async () => (host.querySelector('button[aria-label="Оба показа на весь экран"]') as HTMLButtonElement).click());
    expect(request).toHaveBeenCalledTimes(1);
    // На весь экран уходит контейнер пары, а не один из показов.
    const target = request.mock.contexts[0] as HTMLElement;
    expect(target.querySelectorAll('[class*="screenLabel"]').length).toBe(2);
  });

  it("shows one at a time with a switcher on a phone", async () => {
    narrow = true;
    await act(async () => root.render(createElement(ScreenStages, { screens: two, placeInside: "в Комнате" })));
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Оба рядом")).toBe(false);
    expect(labels()).toEqual(["🖥 Анна"]);
    await act(async () => buttonByText("🖥 Борис").click());
    expect(labels()).toEqual(["🖥 Борис"]);
  });

  it("falls back to the remaining share when the opened one ends", async () => {
    await act(async () => root.render(createElement(ScreenStages, { screens: two, placeInside: "в Комнате" })));
    await act(async () => buttonByText("🖥 Борис").click());
    await act(async () => root.render(createElement(ScreenStages, { screens: [two[0]], placeInside: "в Комнате" })));
    expect(labels()).toEqual(["🖥 Анна"]);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Оба рядом")).toBe(false);
  });

  it("names my own share and keeps its stop button", async () => {
    const stop = vi.fn();
    await act(async () => root.render(createElement(ScreenStages, {
      screens: [screen("me", "Я", { isMine: true, onStop: stop }), two[1]], placeInside: "в Комнате",
    })));
    expect(host.textContent).toContain("Вы показываете экран");
    expect(buttonByText("🖥 Ваш экран")).toBeTruthy();
    await act(async () => buttonByText("Остановить показ").click());
    expect(stop).toHaveBeenCalled();
  });
});

describe("screen audio per share", () => {
  beforeEach(() => useScreenAudio.setState({ enabled: true, volume: 0.8, bySharer: {} }));

  it("gives each share its own volume until the common setting changes", () => {
    useScreenAudio.getState().setSharerAudio("bob", { volume: 0.3 });
    useScreenAudio.getState().setSharerAudio("ann", { enabled: false });
    expect(screenAudioVolume("bob")).toBe(0.3);
    expect(screenAudioVolume("ann")).toBe(0);
    expect(screenAudioVolume("carol")).toBe(0.8);
    expect(sharerAudio(useScreenAudio.getState(), "ann")).toEqual({ enabled: false, volume: 0.8 });
    useScreenAudio.getState().setVolume(0.5);
    expect(screenAudioVolume("bob")).toBe(0.5);
    expect(screenAudioVolume("ann")).toBe(0.5);
  });
});

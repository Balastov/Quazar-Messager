import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceScreen } from "../../../store/voice";
import ScreenStage from "../ScreenStage";
import MessageMenu from "../../messages/MessageMenu";

let host: HTMLDivElement;
let root: Root;
let fullscreenElement: Element | null;
let restoreFullscreen: () => void;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fullscreenElement = null;
  const descriptor = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  restoreFullscreen = () => {
    if (descriptor) Object.defineProperty(document, "fullscreenElement", descriptor);
    else Reflect.deleteProperty(document, "fullscreenElement");
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  restoreFullscreen();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`Missing button: ${label}`);
  return el;
}

function fixture() {
  const microphone = vi.fn();
  const attach = vi.fn();
  const detach = vi.fn();
  const screen = { userId: "sharer", isLocal: false, track: { attach, detach } } as unknown as VoiceScreen;
  const controls = createElement("button", {
    type: "button", "aria-label": "Выключить микрофон", onClick: microphone,
  }, "Микрофон");
  const props = { sharerName: "Анна", placeInside: "в Комнате", isMine: false, screen, controls };
  return { props, microphone, attach, detach };
}

describe("screen sharing fullscreen controls", () => {
  it("keeps working conversation controls inside the native fullscreen element", async () => {
    const { props, microphone, attach } = fixture();
    await act(async () => root.render(createElement(ScreenStage, props)));
    const video = host.querySelector("video")!;
    const frame = video.parentElement!.parentElement!;
    const request = vi.fn(async () => {
      fullscreenElement = frame;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: request });

    await act(async () => button("На весь экран").click());
    expect(request).toHaveBeenCalledOnce();
    expect(fullscreenElement?.contains(button("Выключить микрофон"))).toBe(true);
    await act(async () => button("Выключить микрофон").click());
    expect(microphone).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();

    await act(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(document.querySelector('button[aria-label="Выключить микрофон"]')).toBeNull();
    expect(button("На весь экран")).toBeDefined();
  });

  it("retains the exit button and microphone if the video track temporarily disappears", async () => {
    const { props } = fixture();
    await act(async () => root.render(createElement(ScreenStage, props)));
    const frame = host.querySelector("video")!.parentElement!.parentElement!;
    Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: async () => {
      fullscreenElement = frame;
      document.dispatchEvent(new Event("fullscreenchange"));
    } });
    await act(async () => button("На весь экран").click());
    await act(async () => root.render(createElement(ScreenStage, { ...props, screen: null })));
    expect(fullscreenElement?.contains(button("Выключить микрофон"))).toBe(true);
    expect(button("Выйти из полноэкранного режима")).toBeDefined();
  });

  it("expands within the page with controls when container fullscreen is unavailable", async () => {
    const { props, microphone, attach, detach } = fixture();
    await act(async () => root.render(createElement(ScreenStage, props)));
    const frame = host.querySelector("video")!.parentElement!.parentElement!;
    Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: undefined });
    await act(async () => button("На весь экран").click());
    const expanded = document.querySelector('[role="dialog"][aria-label="Демонстрация экрана"]')!;
    expect(expanded.parentElement).toBe(document.body);
    expect(expanded.contains(button("Выключить микрофон"))).toBe(true);
    await act(async () => button("Выключить микрофон").click());
    expect(microphone).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenLastCalledWith(expanded.querySelector("video"));
    expect(detach).toHaveBeenCalledOnce();

    await act(async () => button("Выйти из полноэкранного режима").click());
    expect(document.querySelector('[aria-label="Демонстрация экрана"]')).toBeNull();
    expect(host.querySelector("video")).not.toBeNull();
    expect(attach).toHaveBeenLastCalledWith(host.querySelector("video"));
  });

  it("falls back when native fullscreen is rejected and supports Escape", async () => {
    const { props } = fixture();
    await act(async () => root.render(createElement(ScreenStage, props)));
    const frame = host.querySelector("video")!.parentElement!.parentElement!;
    Object.defineProperty(frame, "requestFullscreen", {
      configurable: true, value: vi.fn().mockRejectedValue(new Error("Not supported")),
    });
    await act(async () => button("На весь экран").click());
    expect(button("Выключить микрофон")).toBeDefined();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector('[aria-label="Демонстрация экрана"]')).toBeNull();
    expect(button("На весь экран")).toBeDefined();
  });

  it("opens action menus inside the fullscreen element", async () => {
    fullscreenElement = host;
    await act(async () => root.render(createElement(MessageMenu, {
      at: { x: 20, y: 20 }, reaction: null,
      actions: [{ label: "Показать экран", onClick: vi.fn() }], onClose: vi.fn(),
    })));
    expect(host.contains(document.querySelector('[role="menu"]'))).toBe(true);
  });

  it("sends clicks in video coordinates and removes short-lived named pointers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    const { props } = fixture();
    const point = vi.fn();
    await act(async () => root.render(createElement(ScreenStage, { ...props, pointersEnabled: true, onPoint: point,
      pointers: [{ user_id: "bob", name: "Боб", sharer_id: "sharer", x: 0.5, y: 0.5,
        created_at: new Date().toISOString(), expires: Date.now() + 1000 }],
    })));
    const video = host.querySelector("video")!;
    const media = video.parentElement!;
    Object.defineProperties(video, { videoWidth: { configurable: true, value: 1920 }, videoHeight: { configurable: true, value: 1080 } });
    Object.defineProperties(media, { clientWidth: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 600 } });
    await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
    expect(host.textContent).toContain("Боб");
    const toggle = [...host.querySelectorAll("button")].find((el) => el.textContent === "Указатель")!;
    await act(async () => toggle.click());
    const overlay = host.querySelector<HTMLElement>('[aria-label="Указатели на демонстрации"]')!;
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, width: 500, height: 250 } as DOMRect);
    await act(async () => overlay.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 225, clientY: 225 })));
    expect(point).toHaveBeenCalledWith(0.25, 0.5);
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(host.textContent).not.toContain("Боб");
  });
});

describe("screen sharing bar", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  it("sits above the picture, collapses to a corner button and remembers it", async () => {
    const { props } = fixture();
    await act(async () => root.render(createElement(ScreenStage, props)));
    const media = host.querySelector("video")!.parentElement!;
    const bar = button("Свернуть панель показа").parentElement!;
    // Панель — отдельной строкой над картинкой, не поверх неё.
    expect(media.contains(bar)).toBe(false);
    expect(bar.nextElementSibling).toBe(media);

    await act(async () => button("Свернуть панель показа").click());
    expect(host.textContent).not.toContain("🖥 Анна");
    expect(host.querySelector('button[aria-label="На весь экран"]')).toBeNull();
    expect(media.contains(button("Показать панель показа"))).toBe(true);

    // Выбор запоминается.
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(ScreenStage, props)));
    await act(async () => button("Показать панель показа").click());
    expect(host.textContent).toContain("🖥 Анна");
    expect(button("На весь экран")).toBeDefined();
    expect(localStorage.getItem("quazar-screen-bar-collapsed")).toBe("0");
  });
});

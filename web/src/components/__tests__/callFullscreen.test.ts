import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, value: string) => void memory.set(k, value), removeItem: (k: string) => void memory.delete(k) });
vi.mock("../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));

const { useCallStore } = await import("../../store/call");
const { default: CallOverlay } = await import("../CallOverlay");

let host: HTMLDivElement;
let root: Root;

const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const callRoot = () => host.querySelector<HTMLDivElement>('[role="dialog"]')!;

function inCall(screen: boolean) {
  act(() => useCallStore.setState({
    phase: "active", peerUsername: "Боб", media: { audio: true, video: false },
    remoteStream: {} as MediaStream, remoteVideo: { video: false, screen }, localVideo: null,
  } as never));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom не проигрывает медиа и не знает MediaStream.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, get: () => null, set: () => {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => useCallStore.setState({ phase: "idle", remoteStream: null } as never));
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
});

describe("личный звонок: показ собеседника на весь экран", () => {
  it("кнопка есть, когда собеседник показывает экран, и разворачивает окно звонка", async () => {
    let fullscreen: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    (HTMLElement.prototype as HTMLElement).requestFullscreen = function (this: HTMLElement) {
      fullscreen = this;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: () => {
      fullscreen = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    } });
    act(() => root.render(createElement(CallOverlay)));
    inCall(false);
    expect(button("На весь экран")).toBeNull(); // видео собеседника нет — разворачивать нечего
    inCall(true);
    await act(async () => Simulate.click(button("На весь экран")!));
    expect(fullscreen).toBe(callRoot());
    expect(callRoot().className).toMatch(/rootFull/);
    await act(async () => Simulate.click(button("Выйти из полноэкранного режима")!));
    expect(fullscreen).toBeNull();
    expect(callRoot().className).not.toMatch(/rootFull/);
    // Двойной клик по видео — тоже на весь экран.
    await act(async () => Simulate.doubleClick(host.querySelector("video")!));
    expect(fullscreen).toBe(callRoot());
    await act(async () => Simulate.click(button("Выйти из полноэкранного режима")!));
    delete (document as Partial<Document> & { fullscreenElement?: unknown }).fullscreenElement;
    delete (document as Partial<Document>).exitFullscreen;
  });

  it("без полноэкранного режима браузера — на всю страницу, Esc сворачивает", async () => {
    act(() => root.render(createElement(CallOverlay)));
    inCall(true);
    await act(async () => Simulate.click(button("На весь экран")!));
    expect(callRoot().className).toMatch(/rootFull/);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(callRoot().className).not.toMatch(/rootFull/);
  });
});

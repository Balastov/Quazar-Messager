import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value), removeItem: (key: string) => void memory.delete(key) });
const { useScreenAudio } = await import("../../store/screenAudio");
const { default: ScreenAudioControls } = await import("../ScreenAudioControls");
const { default: ScreenShareDialog } = await import("../ScreenShareDialog");
const { default: ScreenAudioPlayer } = await import("../ScreenAudioPlayer");
const { default: ScreenStage } = await import("../constellation/ScreenStage");

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useScreenAudio.setState({ shareAudio: false, enabled: true, volume: 1 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("screen audio settings", () => {
  it("keeps viewer volume while muting and remembers the settings on the device", async () => {
    await act(async () => root.render(createElement(ScreenAudioControls, { available: true })));
    const volume = host.querySelector<HTMLInputElement>('[aria-label="Громкость трансляции"]')!;
    await act(async () => { volume.value = "37"; Simulate.change(volume); });
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => toggle.click());
    expect(useScreenAudio.getState()).toMatchObject({ enabled: false, volume: 0.37 });
    expect(volume.disabled).toBe(true);
    await act(async () => toggle.click());
    expect(useScreenAudio.getState()).toMatchObject({ enabled: true, volume: 0.37 });
    expect(volume.value).toBe("37");
    expect(JSON.parse(memory.get("quazar-screen-audio")!)).toMatchObject({ enabled: true, volume: 0.37 });
  });

  it("passes the explicit sharing choice directly from the start button", async () => {
    const start = vi.fn(), close = vi.fn();
    await act(async () => root.render(createElement(ScreenShareDialog, { onStart: start, onClose: close })));
    const selects = host.querySelectorAll("select");
    await act(async () => { selects[0].value = "motion"; Simulate.change(selects[0]); selects[1].value = "yes"; Simulate.change(selects[1]); });
    const button = [...host.querySelectorAll("button")].find((el) => el.textContent === "Выбрать источник и начать")!;
    await act(async () => button.click());
    expect(start).toHaveBeenCalledWith("motion", true);
    expect(close).toHaveBeenCalledOnce();
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it("disables audio capture for a legacy peer while still allowing silent sharing", async () => {
    useScreenAudio.setState({ shareAudio: true });
    const start = vi.fn();
    await act(async () => root.render(createElement(ScreenShareDialog, { audioSupported: false, quality: false, onStart: start, onClose: vi.fn() })));
    expect(host.querySelector("select")?.disabled).toBe(true);
    const button = [...host.querySelectorAll("button")].find((el) => el.textContent === "Выбрать источник и начать")!;
    await act(async () => button.click());
    expect(start).toHaveBeenCalledWith("detail", false);
  });

  it("applies viewer settings only to the separate screen player", async () => {
    const stream = new MediaStream();
    vi.spyOn(stream, "getAudioTracks").mockReturnValue([{ id: "screen-audio", kind: "audio" } as MediaStreamTrack]);
    await act(async () => root.render(createElement(ScreenAudioPlayer, { stream })));
    const audio = host.querySelector("audio")!;
    await act(async () => useScreenAudio.getState().setVolume(0.42));
    expect(audio.volume).toBe(0.42);
    await act(async () => useScreenAudio.getState().setEnabled(false));
    expect(audio.muted).toBe(true);
    await act(async () => useScreenAudio.getState().setEnabled(true));
    expect(audio.volume).toBe(0.42);
    expect(audio.muted).toBe(false);
  });

  it("keeps sound controls inside native fullscreen alongside the microphone", async () => {
    let fullscreen: Element | null = null;
    const previous = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    try {
      const screen = { userId: "sharer", isLocal: false, track: { attach: vi.fn(), detach: vi.fn() } };
      await act(async () => root.render(createElement(ScreenStage, { sharerName: "Анна", placeInside: "в Комнате",
        screen: screen as never, isMine: false, audioControls: createElement(ScreenAudioControls, { available: true }),
        controls: createElement("button", { "aria-label": "Микрофон" }, "Микрофон"),
      })));
      const frame = host.querySelector("video")!.parentElement!.parentElement!;
      Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: async () => {
        fullscreen = frame; document.dispatchEvent(new Event("fullscreenchange"));
      } });
      await act(async () => (host.querySelector('[aria-label="На весь экран"]') as HTMLButtonElement).click());
      expect(frame.querySelector('[aria-label="Микрофон"]')).not.toBeNull();
      const volume = frame.querySelector<HTMLInputElement>('[aria-label="Громкость трансляции"]')!;
      expect(volume).not.toBeNull();
      await act(async () => { volume.value = "22"; Simulate.change(volume); });
      expect(useScreenAudio.getState().volume).toBe(0.22);
    } finally {
      if (previous) Object.defineProperty(document, "fullscreenElement", previous);
      else Reflect.deleteProperty(document, "fullscreenElement");
    }
  });
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ microphone: vi.fn(), create: vi.fn(), stop: vi.fn(), close: vi.fn() }));
vi.mock("../../calls/devices", () => ({ getMicrophone: mocks.microphone }));
vi.mock("../../calls/noiseSuppression", () => ({ failedOnThisDevice: () => false, clearFailedOnThisDevice: vi.fn(), NoiseSuppressedMic: { create: mocks.create } }));
vi.mock("../../store/voice", () => ({ micErrorText: () => "Разрешите доступ к микрофону" }));
import MicCheck from "../MicCheck";
let root: Root, host: HTMLDivElement;
const track = { stop: mocks.stop, label: "Test", getSettings: () => ({ sampleRate: 48000 }) };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  mocks.microphone.mockResolvedValue(stream); mocks.create.mockResolvedValue(null);
  class Context { resume = () => Promise.resolve(); close = mocks.close;
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData: (buffer: Float32Array) => { buffer.fill(0); buffer[0] = .1; } }; }
    createMediaStreamSource() { return { connect: vi.fn() }; }
  }
  vi.stubGlobal("AudioContext", Context);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(disabled = false) { await act(async () => root.render(createElement(MicCheck, { buttonClass: "button", hintClass: "hint", disabled }))); }
async function start() { await act(async () => host.querySelector("button")!.click()); }
it("starts only on explicit request and releases the microphone after eight seconds", async () => {
  await mount(); expect(mocks.microphone).not.toHaveBeenCalled(); await start();
  expect(mocks.microphone).toHaveBeenCalledOnce(); await act(async () => vi.advanceTimersByTime(8000));
  expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.close).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Микрофон улавливает ваш голос");
});
it("releases permission granted after the checker was closed", async () => {
  let finish!: (stream: any) => void; mocks.microphone.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(); await start(); await act(async () => root.render(null)); await act(async () => finish(stream));
  expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.create).not.toHaveBeenCalled();
});
it("closes a denoiser that finishes initializing after unmount", async () => {
  let finish!: (value: any) => void; mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(); await start(); await act(async () => root.render(null));
  const close = vi.fn(); await act(async () => finish({ close }));
  expect(mocks.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it("does not acquire a microphone during a call and explains denied permission", async () => {
  await mount(true); await start(); expect(mocks.microphone).not.toHaveBeenCalled();
  mocks.microphone.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  await mount(false); await start(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Разрешите доступ");
});

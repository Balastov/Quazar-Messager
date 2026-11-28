import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({
  engine: "rnnoise" as "rnnoise" | "gtcrn",
  gate: null as number | null,
  setEngine: vi.fn((engine: "rnnoise" | "gtcrn") => { prefs.engine = engine; prefs.listeners.forEach((l) => l()); }),
  listeners: new Set<() => void>(),
  setGate: vi.fn(),
}));
vi.mock("../../calls/noiseSuppression", () => ({
  GATE_MIN_DB: -70,
  GATE_MAX_DB: -20,
  NOISE_ENGINES: ["rnnoise", "gtcrn"],
  NoiseSuppressedMic: { create: vi.fn() },
  engineFailedOnThisDevice: () => false,
  getNoiseEnginePref: () => prefs.engine,
  subscribeNoiseEngine: (listener: () => void) => { prefs.listeners.add(listener); return () => prefs.listeners.delete(listener); },
  getMicGatePref: () => prefs.gate,
  getMicGateLevelPref: () => prefs.gate ?? -50,
  setNoiseEnginePref: prefs.setEngine,
  setMicGatePref: prefs.setGate,
}));
vi.mock("../../calls/devices", () => ({ getMicrophone: vi.fn() }));
const call = vi.hoisted(() => ({ noiseSuppression: true, phase: "idle", toggleNoiseSuppression: vi.fn() }));
vi.mock("../../store/call", () => ({ useCallStore: (selector: (state: typeof call) => unknown) => selector(call) }));
const voice = vi.hoisted(() => ({ status: "idle" }));
vi.mock("../../store/voice", () => ({
  micErrorText: () => "",
  useVoiceStore: (selector: (state: typeof voice) => unknown) => selector(voice),
}));

const { default: NoiseSettings } = await import("../settings/NoiseSettings");

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prefs.engine = "rnnoise"; prefs.gate = null;
  call.noiseSuppression = true; call.phase = "idle"; voice.status = "idle";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = () => act(async () => root.render(createElement(NoiseSettings)));
const radio = (text: string) => [...host.querySelectorAll("label")].find(l => l.textContent?.includes(text))!.querySelector("input")!;
const gateToggle = () => [...host.querySelectorAll("label")].find(l => l.textContent === "Порог микрофона")!.querySelector("input")!;
const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.includes(text));

it("switches the neural network right away", async () => {
  await render();
  expect(radio("RNNoise").checked).toBe(true);
  await act(async () => radio("GTCRN").click());
  expect(prefs.setEngine).toHaveBeenCalledWith("gtcrn");
  expect(radio("GTCRN").checked).toBe(true);
});

it("turns the gate on at the remembered level and moves it with the slider", async () => {
  await render();
  expect(host.querySelector("#mic-gate")).toBeNull();
  await act(async () => gateToggle().click());
  expect(prefs.setGate).toHaveBeenLastCalledWith(-50);
  const slider = host.querySelector<HTMLInputElement>("#mic-gate")!;
  await act(async () => { slider.value = "-40"; Simulate.change(slider); });
  expect(prefs.setGate).toHaveBeenLastCalledWith(-40);
  expect(host.textContent).toContain("−40 дБ");
  await act(async () => gateToggle().click());
  expect(prefs.setGate).toHaveBeenLastCalledWith(null);
});

it("does not open the microphone for checks during a call", async () => {
  prefs.gate = -45; call.phase = "active";
  await render();
  expect(button("Настроить по голосу")!.disabled).toBe(true);
  expect(button("Записать пример")!.disabled).toBe(true);
  expect(host.textContent).toContain("вне звонка");
});

it("disables network and gate choices while noise suppression is off", async () => {
  call.noiseSuppression = false;
  await render();
  expect([...host.querySelectorAll("fieldset")].every(f => f.disabled)).toBe(true);
  expect(button("Записать пример")).toBeUndefined();
});

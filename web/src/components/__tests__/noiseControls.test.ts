import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Meter = { levelDb: number; open: boolean };
const prefs = vi.hoisted(() => {
  const state = {
    engine: "gtcrn" as "rnnoise" | "gtcrn",
    gate: null as number | null,
    level: -50,
    listeners: new Set<() => void>(),
    meters: new Set<(meter: Meter) => void>(),
    notify: () => state.listeners.forEach((listener) => listener()),
    setEngine: vi.fn((engine: "rnnoise" | "gtcrn") => { state.engine = engine; state.notify(); }),
    setGate: vi.fn((db: number | null) => { state.gate = db; if (db !== null) state.level = db; state.notify(); }),
  };
  return state;
});
vi.mock("../../calls/noiseSuppression", () => ({
  GATE_MIN_DB: -70,
  GATE_MAX_DB: -20,
  engineFailedOnThisDevice: () => false,
  getNoiseEnginePref: () => prefs.engine,
  getMicGatePref: () => prefs.gate,
  getMicGateLevelPref: () => prefs.level,
  setNoiseEnginePref: prefs.setEngine,
  setMicGatePref: prefs.setGate,
  subscribeNoisePrefs: (listener: () => void) => { prefs.listeners.add(listener); return () => prefs.listeners.delete(listener); },
  watchLiveGateMeter: (listener: (meter: Meter) => void) => { prefs.meters.add(listener); return () => prefs.meters.delete(listener); },
}));

const { default: NoiseControls } = await import("../NoiseControls");

let host: HTMLDivElement, root: Root;
const toggle = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prefs.engine = "gtcrn"; prefs.gate = null; prefs.level = -50; prefs.meters.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = (enabled = true, live = false) =>
  act(async () => root.render(createElement(NoiseControls, { enabled, toggle, live })));
const option = (title: string) => [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith(title))!.querySelector("input")!;
const gateToggle = () => [...host.querySelectorAll("label")].find((l) => l.textContent === "Порог микрофона")!.querySelector("input")!;
const slider = () => host.querySelector<HTMLInputElement>('input[type="range"]');

it("shows three modes with GTCRN checked by default", async () => {
  await render();
  expect(option("Без обработки").checked).toBe(false);
  expect(option("RNNoise").checked).toBe(false);
  expect(option("GTCRN").checked).toBe(true);
  expect(host.textContent).toContain("по умолчанию");
});

it("RNNoise switches the engine; «Без обработки» turns suppression off", async () => {
  await render();
  await act(async () => option("RNNoise").click());
  expect(prefs.setEngine).toHaveBeenCalledWith("rnnoise");
  expect(option("RNNoise").checked).toBe(true);
  expect(toggle).not.toHaveBeenCalled();
  await act(async () => option("Без обработки").click());
  expect(toggle).toHaveBeenCalledOnce();
});

it("when suppression is off, picking a network turns it on; the gate waits for it", async () => {
  await render(false);
  expect(option("Без обработки").checked).toBe(true);
  expect(gateToggle().closest("fieldset")!.disabled).toBe(true);
  await act(async () => option("GTCRN").click());
  expect(toggle).toHaveBeenCalledOnce();
  expect(prefs.setEngine).not.toHaveBeenCalled();
});

it("the gate toggle and slider apply right away", async () => {
  await render();
  expect(slider()).toBeNull();
  await act(async () => gateToggle().click());
  expect(prefs.setGate).toHaveBeenLastCalledWith(-50);
  await act(async () => { slider()!.value = "-40"; Simulate.change(slider()!); });
  expect(prefs.setGate).toHaveBeenLastCalledWith(-40);
  expect(host.textContent).toContain("−40 дБ");
  await act(async () => gateToggle().click());
  expect(prefs.setGate).toHaveBeenLastCalledWith(null);
  expect(slider()).toBeNull();
});

it("during a conversation shows the level of the microphone in use", async () => {
  prefs.gate = -45; prefs.level = -45;
  await render(true, true);
  expect(host.querySelector('[role="meter"]')).toBeNull();
  await act(async () => prefs.meters.forEach((listener) => listener({ levelDb: -60, open: false })));
  expect(host.querySelector('[role="meter"]')).not.toBeNull();
  expect(host.textContent).toContain("Тишина");
  await act(async () => prefs.meters.forEach((listener) => listener({ levelDb: -30, open: true })));
  expect(host.textContent).toContain("Собеседники вас слышат");
});

it("two copies on screen do not share radio groups", async () => {
  await act(async () => root.render(createElement("div", null,
    createElement(NoiseControls, { enabled: true, toggle }), createElement(NoiseControls, { enabled: true, toggle }))));
  const names = new Set([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((input) => input.name));
  expect(names.size).toBe(2);
});

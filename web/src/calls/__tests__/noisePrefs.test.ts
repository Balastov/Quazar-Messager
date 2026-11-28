import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
});
import {
  GATE_DEFAULT_DB,
  GATE_MAX_DB,
  GATE_MIN_DB,
  engineFailedOnThisDevice,
  getMicGateLevelPref,
  getMicGatePref,
  getNoiseEnginePref,
  setMicGatePref,
  setNoiseEnginePref,
  subscribeNoisePrefs,
} from "../noiseSuppression";

beforeEach(() => localStorage.clear());

describe("noise engine preference", () => {
  it("defaults to GTCRN and remembers RNNoise", () => {
    expect(getNoiseEnginePref()).toBe("gtcrn");
    setNoiseEnginePref("rnnoise");
    expect(getNoiseEnginePref()).toBe("rnnoise");
    localStorage.setItem("quazar_noise_engine", "something-else");
    expect(getNoiseEnginePref()).toBe("gtcrn");
  });

  it("notifies subscribers about the new engine", () => {
    const seen: string[] = [];
    const off = subscribeNoisePrefs(() => seen.push(getNoiseEnginePref()));
    setNoiseEnginePref("rnnoise");
    off();
    setNoiseEnginePref("gtcrn");
    expect(seen).toEqual(["rnnoise"]);
  });

  it("choosing an engine again gives it another chance on this device", () => {
    localStorage.setItem("quazar_noise_engine_failed", "gtcrn");
    expect(engineFailedOnThisDevice("gtcrn")).toBe(true);
    expect(engineFailedOnThisDevice("rnnoise")).toBe(false);
    setNoiseEnginePref("gtcrn");
    expect(engineFailedOnThisDevice("gtcrn")).toBe(false);
  });
});

describe("microphone gate preference", () => {
  it("is off by default with a sensible slider position", () => {
    expect(getMicGatePref()).toBeNull();
    expect(getMicGateLevelPref()).toBe(GATE_DEFAULT_DB);
  });

  it("clamps the threshold and keeps the slider value when turned off", () => {
    setMicGatePref(-5);
    expect(getMicGatePref()).toBe(GATE_MAX_DB);
    setMicGatePref(-200);
    expect(getMicGatePref()).toBe(GATE_MIN_DB);
    setMicGatePref(-44.6);
    expect(getMicGatePref()).toBe(-45);
    setMicGatePref(null);
    expect(getMicGatePref()).toBeNull();
    expect(getMicGateLevelPref()).toBe(-45);
  });
});

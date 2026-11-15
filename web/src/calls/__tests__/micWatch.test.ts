import { beforeEach, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
let devices: { kind: string; deviceId: string; groupId: string }[] = [];
vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => devices } });
const { micNeedsSwitch, serial } = await import("../micWatch");
const { setPreferredInput } = await import("../devices");

const track = (settings: MediaTrackSettings, patch: Partial<MediaStreamTrack> = {}) =>
  ({ readyState: "live", muted: false, getSettings: () => settings, ...patch }) as MediaStreamTrack;
const input = (deviceId: string, groupId = `g-${deviceId}`) => ({ kind: "audioinput", deviceId, groupId });

beforeEach(() => {
  memory.clear();
  setPreferredInput("");
  devices = [input("default", "g-built-in"), input("built-in"), input("usb")];
});

it("takes the microphone again when the old one was unplugged", async () => {
  expect(await micNeedsSwitch(track({ deviceId: "usb" }, { readyState: "ended" }))).toBe(true);
  // Safari: трек не завершился, но устройство пропало или трек онемел.
  expect(await micNeedsSwitch(track({ deviceId: "headset" }))).toBe(true);
  expect(await micNeedsSwitch(track({ deviceId: "usb" }, { muted: true }))).toBe(true);
});

it("returns to the chosen microphone when it is plugged back", async () => {
  setPreferredInput("usb");
  expect(await micNeedsSwitch(track({ deviceId: "built-in" }))).toBe(true);
  expect(await micNeedsSwitch(track({ deviceId: "usb" }))).toBe(false);
  devices = [input("default", "g-built-in"), input("built-in")];
  // Выбранного нет — остаёмся на том, что работает.
  expect(await micNeedsSwitch(track({ deviceId: "built-in" }))).toBe(false);
});

it("follows the system default microphone in Chromium", async () => {
  expect(await micNeedsSwitch(track({ deviceId: "default", groupId: "g-built-in" }))).toBe(false);
  devices = [input("default", "g-usb"), input("built-in"), input("usb")];
  expect(await micNeedsSwitch(track({ deviceId: "default", groupId: "g-built-in" }))).toBe(true);
  // Без записи «default» (Safari, Firefox) работающий микрофон не трогаем.
  devices = [input("built-in"), input("usb")];
  expect(await micNeedsSwitch(track({ deviceId: "built-in", groupId: "g-built-in" }))).toBe(false);
});

it("does nothing without a microphone", async () => {
  expect(await micNeedsSwitch(null)).toBe(false);
});

it("runs one check at a time and repeats once for events that came meanwhile", async () => {
  let release!: () => void;
  const runs: number[] = [];
  const check = serial(async () => {
    runs.push(runs.length);
    if (runs.length === 1) await new Promise<void>((done) => { release = done; });
  });
  const first = check();
  void check();
  void check();
  release();
  await first;
  expect(runs).toEqual([0, 1]);
});

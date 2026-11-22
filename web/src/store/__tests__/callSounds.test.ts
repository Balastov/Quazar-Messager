import { beforeEach, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({ startRingback: vi.fn(), stopRingback: vi.fn(), play: vi.fn(async () => {}) }));
vi.mock("../../notifications/sound", () => ({
  startCallRingtone: () => () => {},
  startConnectionLostTone: () => () => {},
  startRingback: () => {
    sounds.startRingback();
    return sounds.stopRingback;
  },
  playCallSound: sounds.play,
  getCtx: () => null,
}));

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
});

const { useCallStore } = await import("../call");
const phase = (value: string) => useCallStore.setState({ phase: value as never });

beforeEach(() => {
  phase("idle");
  vi.clearAllMocks();
});

it("rings back while the callee has not answered, then sounds the connection and the end", () => {
  phase("outgoing");
  expect(sounds.startRingback).toHaveBeenCalledOnce();
  phase("connecting");
  expect(sounds.stopRingback).toHaveBeenCalledOnce();
  phase("active");
  phase("active");
  expect(sounds.play).toHaveBeenCalledTimes(1);
  expect(sounds.play).toHaveBeenLastCalledWith("connected");
  phase("ended");
  expect(sounds.play).toHaveBeenLastCalledWith("ended");
  phase("idle");
  expect(sounds.play).toHaveBeenCalledTimes(2);
});

it("sounds the end when nobody answered, but stays quiet for a missed incoming call", () => {
  phase("outgoing");
  phase("ended");
  expect(sounds.stopRingback).toHaveBeenCalledOnce();
  expect(sounds.play).toHaveBeenCalledWith("ended");
  phase("idle");
  vi.clearAllMocks();
  phase("incoming");
  phase("ended");
  expect(sounds.play).not.toHaveBeenCalled();
  expect(sounds.startRingback).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vitest";

const play = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../sounds/starSounds", () => ({ playStarSound: play }));

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
});

await import("../recording");
const { useStarsStore } = await import("../stars");
const { useVoiceStore } = await import("../voice");

function presence(recording: boolean) {
  useStarsStore.setState({
    details: { s1: { voice: { p1: [{ user_id: "bob", joined_at: "", recording }] } } } as never,
  });
}

beforeEach(() => {
  useVoiceStore.setState({ status: "connected", starId: "s1", channelId: "p1" });
  presence(false);
  play.mockClear();
});

it("sounds when a recording in my room starts and when it stops", () => {
  presence(true);
  expect(play).toHaveBeenLastCalledWith("recordOn");
  presence(false);
  expect(play).toHaveBeenLastCalledWith("recordOff");
  expect(play).toHaveBeenCalledTimes(2);
});

it("stays quiet about the recording when I leave the room myself", () => {
  presence(true);
  play.mockClear();
  useVoiceStore.setState({ status: "idle", starId: null, channelId: null });
  presence(false);
  expect(play).not.toHaveBeenCalled();
});

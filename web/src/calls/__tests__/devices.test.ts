import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
});

const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();
const audioSession = { type: "auto" };
vi.stubGlobal("navigator", {
  mediaDevices: { getUserMedia, enumerateDevices },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  maxTouchPoints: 5,
  audioSession,
});

const devices = await import("../devices");

beforeEach(() => {
  memoryStorage.clear();
  getUserMedia.mockReset();
  enumerateDevices.mockReset();
});

describe("audio devices", () => {
  it("uses the chosen microphone and falls back to the system one if it is gone", async () => {
    devices.setPreferredInput("usb-mic");
    getUserMedia
      .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
      .mockResolvedValueOnce("system-stream");
    const stream = await devices.getMicrophone({ echoCancellation: true });
    expect(stream).toBe("system-stream");
    expect(getUserMedia.mock.calls[0][0]).toEqual({
      audio: { echoCancellation: true, deviceId: { exact: "usb-mic" } },
    });
    expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: { echoCancellation: true } });
  });

  it("does not hide a permission problem behind the fallback", async () => {
    devices.setPreferredInput("usb-mic");
    getUserMedia.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    await expect(devices.getMicrophone({})).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("lists devices without system aliases and with readable names", async () => {
    enumerateDevices.mockResolvedValue([
      { kind: "audioinput", deviceId: "default", label: "" },
      { kind: "audioinput", deviceId: "m1", label: "" },
      { kind: "audioinput", deviceId: "m2", label: "" },
      { kind: "audiooutput", deviceId: "communications", label: "Связь" },
      { kind: "audiooutput", deviceId: "s1", label: "Наушники" },
      { kind: "videoinput", deviceId: "c1", label: "Камера" },
    ]);
    const list = await devices.listAudioDevices();
    expect(list.inputs).toEqual([
      { deviceId: "m1", label: "Микрофон 1" },
      { deviceId: "m2", label: "Микрофон 2" },
    ]);
    expect(list.outputs).toEqual([{ deviceId: "s1", label: "Наушники" }]);
    expect(list.labelsHidden).toBe(true);
  });

  it("routes sound to the chosen speaker and back to the system one if it fails", async () => {
    const calls: string[] = [];
    class FakeMedia {
      sinkId = "";
      async setSinkId(id: string) {
        calls.push(id);
        if (id === "unplugged") throw new DOMException("x", "NotFoundError");
        this.sinkId = id;
      }
    }
    vi.stubGlobal("HTMLMediaElement", FakeMedia);
    const el = new FakeMedia() as unknown as HTMLMediaElement;
    await devices.applyOutput(el, "s1");
    expect((el as unknown as FakeMedia).sinkId).toBe("s1");
    await devices.applyOutput(el, "unplugged");
    expect(calls).toEqual(["s1", "unplugged", ""]);
  });

  it("switches iPhone between loudspeaker and earpiece via the audio session", () => {
    expect(devices.canSwitchIosRoute()).toBe(true);
    devices.setIosRoute("receiver");
    expect(audioSession.type).toBe("play-and-record");
    expect(devices.getIosRoute()).toBe("receiver");
    devices.setIosRoute("speaker");
    expect(audioSession.type).toBe("auto");
  });
});

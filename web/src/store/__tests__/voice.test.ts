import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
});

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(readonly id: string) {}
  stop() {
    this.stopped = true;
  }
  async applyConstraints() {}
}

class FakePublication {
  isMuted = false;
  audioTrack = { replaceTrack: vi.fn(async () => {}) };
  constructor(readonly track: FakeTrack) {}
  async mute() {
    this.isMuted = true;
  }
  async unmute() {
    this.isMuted = false;
  }
}

class FakeRoom {
  static last: FakeRoom | null = null;
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  canPlaybackAudio = true;
  remoteParticipants = new Map();
  published: FakePublication[] = [];
  localParticipant = {
    identity: "me",
    name: "я",
    isSpeaking: false,
    isMicrophoneEnabled: true,
    permissions: { canPublish: true },
    publishTrack: vi.fn(async (track: FakeTrack) => {
      const pub = new FakePublication(track);
      this.published.push(pub);
      return pub;
    }),
  };
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  startAudio = vi.fn(async () => {});
  constructor(readonly options: Record<string, unknown>) {
    FakeRoom.last = this;
  }
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: new Proxy({}, { get: (_t, name) => String(name) }),
  Track: { Source: { Microphone: "microphone" } },
  DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 },
}));

class FakeDenoiser {
  static fail = false;
  static last: FakeDenoiser | null = null;
  track = new FakeTrack("denoised");
  enabled = true;
  closed = false;
  onFailed: (() => void) | null = null;
  setEnabled(on: boolean) {
    this.enabled = on;
  }
  close() {
    this.closed = true;
  }
}

vi.mock("../../calls/noiseSuppression", () => ({
  getNoiseSuppressionPref: () => true,
  setNoiseSuppressionPref: () => {},
  isNoiseSuppressionSupported: () => true,
  preloadNoiseSuppression: () => Promise.resolve(new ArrayBuffer(0)),
  setBrowserNoiseSuppression: async () => {},
  NoiseSuppressedMic: {
    create: async () => {
      if (FakeDenoiser.fail) return null;
      FakeDenoiser.last = new FakeDenoiser();
      return FakeDenoiser.last;
    },
  },
}));

const joinPlanet = vi.fn(async () => ({ url: "wss://example.test/livekit", token: "tok", room: "planet-p1" }));
vi.mock("../../api/stars", () => ({ starsApi: { joinPlanet: (...a: unknown[]) => joinPlanet(...(a as [])) } }));

const callState = { phase: "idle" };
vi.mock("../call", () => ({ useCallStore: { getState: () => callState } }));

let mic: FakeTrack;
let micDenied = false;
vi.stubGlobal("navigator", {
  mediaDevices: {
    getUserMedia: async () => {
      if (micDenied) throw new DOMException("denied", "NotAllowedError");
      return { getAudioTracks: () => [mic] };
    },
  },
});

const { useVoiceStore } = await import("../voice");

beforeEach(async () => {
  await useVoiceStore.getState().leave();
  useVoiceStore.setState({ notice: null, error: null, noiseSuppression: true });
  FakeRoom.last = null;
  FakeDenoiser.fail = false;
  micDenied = false;
  callState.phase = "idle";
  mic = new FakeTrack("mic");
  joinPlanet.mockClear();
});

describe("voice store", () => {
  it("joins with a token and publishes the denoised microphone", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const room = FakeRoom.last!;
    expect(joinPlanet).toHaveBeenCalledWith("s1", "p1");
    expect(room.connect).toHaveBeenCalledWith("wss://example.test/livekit", "tok");
    expect(room.options.stopLocalTrackOnUnpublish).toBe(false);
    expect(room.published[0].track.id).toBe("denoised");
    const st = useVoiceStore.getState();
    expect(st.status).toBe("connected");
    expect(st.noiseActive).toBe(true);
    expect(st.peers.map((p) => p.userId)).toEqual(["me"]);
  });

  it("falls back to the plain microphone when RNNoise is unavailable", async () => {
    FakeDenoiser.fail = true;
    await useVoiceStore.getState().join("s1", "p1");
    expect(FakeRoom.last!.published[0].track.id).toBe("mic");
    expect(useVoiceStore.getState().noiseActive).toBe(false);
  });

  it("stays to listen when the microphone is denied", async () => {
    micDenied = true;
    await useVoiceStore.getState().join("s1", "p1");
    const st = useVoiceStore.getState();
    expect(st.status).toBe("connected");
    expect(st.micUnavailable).toBe(true);
    expect(st.micError).toMatch(/Разрешите/);
    expect(FakeRoom.last!.published).toHaveLength(0);
  });

  it("turns the microphone on later without leaving the planet", async () => {
    micDenied = true;
    await useVoiceStore.getState().join("s1", "p1");
    const room = FakeRoom.last!;

    micDenied = false;
    await useVoiceStore.getState().retryMic();
    const st = useVoiceStore.getState();
    expect(st.micUnavailable).toBe(false);
    expect(st.micError).toBeNull();
    expect(room.published[0].track.id).toBe("denoised");
    expect(FakeRoom.last).toBe(room);
  });

  it("refuses to join during a personal call", async () => {
    callState.phase = "active";
    await useVoiceStore.getState().join("s1", "p1");
    expect(joinPlanet).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().error).toBe("Сначала завершите звонок");
  });

  it("leaves cleanly and releases the microphone", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const room = FakeRoom.last!;
    await useVoiceStore.getState().leave();
    expect(room.disconnect).toHaveBeenCalled();
    expect(mic.stopped).toBe(true);
    expect(FakeDenoiser.last!.closed).toBe(true);
    expect(useVoiceStore.getState().status).toBe("idle");
    expect(useVoiceStore.getState().notice).toBeNull();
  });

  it("explains being removed by a moderator", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    FakeRoom.last!.emit("Disconnected", 4);
    await vi.waitFor(() => expect(useVoiceStore.getState().status).toBe("idle"));
    expect(useVoiceStore.getState().notice).toBe("Вас вывели с Планеты");
    expect(mic.stopped).toBe(true);
  });

  it("republishes the microphone after a moderator returns it", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const room = FakeRoom.last!;
    const local = room.localParticipant;

    local.permissions = { canPublish: false };
    room.emit("ParticipantPermissionsChanged", undefined, local);
    expect(useVoiceStore.getState().serverMuted).toBe(true);

    local.permissions = { canPublish: true };
    room.emit("ParticipantPermissionsChanged", undefined, local);
    await vi.waitFor(() => expect(room.published).toHaveLength(2));
    expect(room.published[1].track.id).toBe("denoised");
    // Вернули право говорить — но включает микрофон сам человек.
    await vi.waitFor(() => expect(room.published[1].isMuted).toBe(true));
    expect(useVoiceStore.getState().serverMuted).toBe(false);
  });

  it("switching planets leaves the previous one", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const first = FakeRoom.last!;
    await useVoiceStore.getState().join("s1", "p2");
    expect(first.disconnect).toHaveBeenCalled();
    expect(FakeRoom.last).not.toBe(first);
    expect(useVoiceStore.getState().channelId).toBe("p2");
  });
});

describe("micErrorText", () => {
  it("explains each kind of failure", async () => {
    const { micErrorText } = await import("../voice");
    expect(micErrorText(new DOMException("x", "NotAllowedError"))).toMatch(/Разрешите/);
    expect(micErrorText(new DOMException("x", "NotFoundError"))).toMatch(/не найден/);
    expect(micErrorText(new DOMException("x", "NotReadableError"))).toMatch(/занят/);
    expect(micErrorText(new Error("publish timed out"))).toMatch(/publish timed out/);
  });
});

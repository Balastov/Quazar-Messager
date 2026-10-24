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
  constructor(
    readonly id: string,
    readonly source = "microphone"
  ) {}
  stop() {
    this.stopped = true;
  }
  async applyConstraints() {}
}

class FakePublication {
  isMuted = false;
  audioTrack = { replaceTrack: vi.fn(async () => {}) };
  constructor(
    readonly track: FakeTrack,
    readonly source: string
  ) {}
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
  // Сколько живых публикаций: published хранит и снятые — для проверок истории.
  live = new Set<FakePublication>();
  screenTracks: FakeTrack[] = [new FakeTrack("screen", "screen_share"), new FakeTrack("tab-audio", "screen_share_audio")];
  localParticipant = {
    identity: "me",
    name: "я",
    isSpeaking: false,
    isMicrophoneEnabled: true,
    permissions: { canPublish: true, canPublishSources: [2] } as { canPublish: boolean; canPublishSources?: number[] },
    get isScreenShareEnabled() {
      return false;
    },
    get trackPublications() {
      return new Map([...room().live].map((p, i) => [String(i), p]));
    },
    getTrackPublication: (source: string) => [...this.live].find((p) => p.source === source),
    publishTrack: vi.fn(async (track: FakeTrack, opts?: { source?: string }) => {
      const pub = new FakePublication(track, opts?.source ?? track.source);
      this.published.push(pub);
      this.live.add(pub);
      return pub;
    }),
    unpublishTrack: vi.fn(async (track: FakeTrack) => {
      const pub = [...this.live].find((p) => p.track === track);
      if (!pub) return;
      this.live.delete(pub);
      this.emit("LocalTrackUnpublished", pub);
    }),
    createScreenTracks: vi.fn(async () => this.screenTracks),
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
  off(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== fn));
    return this;
  }
  /** Сервер поменял права участника (как UpdateParticipant). */
  grant(sources: number[]) {
    this.localParticipant.permissions = { canPublish: sources.length > 0, canPublishSources: sources };
    this.emit("ParticipantPermissionsChanged", undefined, this.localParticipant);
  }
  removeAllListeners() {
    this.handlers.clear();
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}

const room = () => FakeRoom.last!;

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: new Proxy({}, { get: (_t, name) => String(name) }),
  Track: { Source: { Microphone: "microphone", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
  ScreenSharePresets: { h1080fps15: { resolution: { width: 1920, height: 1080 }, encoding: { maxBitrate: 1, maxFramerate: 15 } } },
  DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 },
}));

class FakeDenoiser {
  static fail = false;
  static last: FakeDenoiser | null = null;
  track = new FakeTrack("denoised");
  enabled = true;
  closed = false;
  onFailed: ((reason: "silent" | "suspended") => void) | null = null;
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
/** По умолчанию сервер выдаёт слот и права на экран. */
const startScreen = vi.fn(async () => {
  setTimeout(() => room().grant([2, 3, 4]), 0);
});
const stopScreen = vi.fn(async () => {});
vi.mock("../../api/stars", () => ({
  starsApi: {
    joinPlanet: (...a: unknown[]) => joinPlanet(...(a as [])),
    startScreen: (...a: unknown[]) => startScreen(...(a as [])),
    stopScreen: (...a: unknown[]) => stopScreen(...(a as [])),
  },
}));

vi.mock("../../sounds/starSounds", () => ({ playStarSound: async () => {} }));

const callState = { phase: "idle" };
vi.mock("../call", () => ({ useCallStore: { getState: () => callState } }));

/** Стор Созвездия: только режим «Только слушать» Планеты p1. */
type StarsState = { details: Record<string, { channels: { id: string; listen_only?: boolean }[] }> };
const starsState: StarsState = { details: {} };
const starsListeners = new Set<(st: StarsState) => void>();
vi.mock("../stars", () => ({
  useStarsStore: {
    getState: () => starsState,
    subscribe: (fn: (st: StarsState) => void) => {
      starsListeners.add(fn);
      return () => starsListeners.delete(fn);
    },
  },
}));
function setListenOnly(on: boolean) {
  starsState.details = { s1: { channels: [{ id: "p1", listen_only: on }] } };
  starsListeners.forEach((fn) => fn(starsState));
}

let mic: FakeTrack;
let micDenied = false;
let micRequests = 0;
vi.stubGlobal("navigator", {
  mediaDevices: {
    getUserMedia: async () => {
      micRequests++;
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
  starsState.details = {};
  micRequests = 0;
  startScreen.mockClear();
  stopScreen.mockClear();
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

  it("falls back to the plain microphone when RNNoise outputs silence", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const pub = FakeRoom.last!.published[0];
    const denoiser = FakeDenoiser.last!;

    denoiser.onFailed!("silent");
    expect(pub.audioTrack.replaceTrack).toHaveBeenCalledWith(mic, true);
    expect(denoiser.closed).toBe(true);
    const st = useVoiceStore.getState();
    expect(st.noiseActive).toBe(false);
    expect(st.notice).toMatch(/Шумоподавление не заработало/);
    expect(st.status).toBe("connected");
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

    room.grant([]);
    expect(useVoiceStore.getState().serverMuted).toBe(true);
    // Нет MICROPHONE в списке источников — тоже выключен (так мьютят, не трогая показ экрана).
    room.grant([3, 4]);
    expect(useVoiceStore.getState().serverMuted).toBe(true);

    room.grant([2]);
    await vi.waitFor(() => expect(room.published).toHaveLength(2));
    expect(room.published[1].track.id).toBe("denoised");
    // Вернули право говорить — но включает микрофон сам человек.
    await vi.waitFor(() => expect(room.published[1].isMuted).toBe(true));
    expect(useVoiceStore.getState().serverMuted).toBe(false);
  });

  it("switches to another microphone without reconnecting", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const room = FakeRoom.last!;
    const pub = room.published[0];
    const oldMic = mic;
    const oldDenoiser = FakeDenoiser.last!;

    mic = new FakeTrack("usb-mic");
    await useVoiceStore.getState().switchMicrophone();
    const newDenoiser = FakeDenoiser.last!;
    expect(newDenoiser).not.toBe(oldDenoiser);
    expect(pub.audioTrack.replaceTrack).toHaveBeenCalledWith(newDenoiser.track, true);
    expect(oldMic.stopped).toBe(true);
    expect(oldDenoiser.closed).toBe(true);
    expect(room.published).toHaveLength(1); // не переподключались и не публиковали заново
    expect(FakeRoom.last).toBe(room);
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

describe("screen share", () => {
  const sources = () => [...room().live].map((p) => p.source).sort();

  it("publishes the screen only after the server grants the slot", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    await useVoiceStore.getState().startScreenShare();
    expect(startScreen).toHaveBeenCalledWith("s1", "p1");
    expect(sources()).toEqual(["microphone", "screen_share", "screen_share_audio"]);
    const st = useVoiceStore.getState();
    expect(st.sharingScreen).toBe(true);
    expect(st.screenStarting).toBe(false);
    expect(st.screens).toEqual([expect.objectContaining({ userId: "me", isLocal: true })]);
  });

  it("explains a taken slot and releases the captured screen", async () => {
    startScreen.mockImplementationOnce(async () => {
      throw { isAxiosError: true, response: { status: 409, data: { detail: "Сейчас экран показывает Анна" } } };
    });
    await useVoiceStore.getState().join("s1", "p1");
    await useVoiceStore.getState().startScreenShare();
    expect(sources()).toEqual(["microphone"]);
    expect(room().screenTracks.every((t) => t.stopped)).toBe(true);
    expect(useVoiceStore.getState().notice).toBe("Сейчас экран показывает Анна");
    expect(useVoiceStore.getState().sharingScreen).toBe(false);
  });

  it("stays quiet when the person closes the screen picker", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    room().localParticipant.createScreenTracks.mockRejectedValueOnce(new DOMException("x", "NotAllowedError"));
    await useVoiceStore.getState().startScreenShare();
    expect(startScreen).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().notice).toBeNull();
    expect(useVoiceStore.getState().screenStarting).toBe(false);
  });

  it("stops by itself: unpublishes, stops capture, frees the slot", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    await useVoiceStore.getState().startScreenShare();
    await useVoiceStore.getState().stopScreenShare();
    expect(sources()).toEqual(["microphone"]);
    expect(room().screenTracks.every((t) => t.stopped)).toBe(true);
    expect(stopScreen).toHaveBeenCalledWith("s1", "p1");
    expect(useVoiceStore.getState().notice).toBeNull();
    expect(useVoiceStore.getState().sharingScreen).toBe(false);
  });

  it("tells when a moderator stops the screen", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    await useVoiceStore.getState().startScreenShare();
    room().grant([2]);
    await vi.waitFor(() => expect(sources()).toEqual(["microphone"]));
    expect(room().screenTracks.every((t) => t.stopped)).toBe(true);
    expect(useVoiceStore.getState().notice).toBe("Модератор остановил ваш показ экрана");
    expect(useVoiceStore.getState().serverMuted).toBe(false);
  });

  it("stops the capture when leaving the planet", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    await useVoiceStore.getState().startScreenShare();
    const r = room();
    await useVoiceStore.getState().leave();
    expect(r.screenTracks.every((t) => t.stopped)).toBe(true);
  });
});

describe("listen-only planet", () => {
  it("never asks for the microphone", async () => {
    setListenOnly(true);
    await useVoiceStore.getState().join("s1", "p1");
    const room = FakeRoom.last!;
    expect(micRequests).toBe(0);
    expect(room.published).toHaveLength(0);
    room.grant([]);
    const st = useVoiceStore.getState();
    expect(st.listenOnly).toBe(true);
    expect(st.serverMuted).toBe(false); // это не мьют модератором
    expect(st.micUnavailable).toBe(false);
    await useVoiceStore.getState().retryMic();
    expect(micRequests).toBe(0);
  });

  it("releases the microphone when the planet becomes listen-only", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const denoiser = FakeDenoiser.last!;
    setListenOnly(true);
    FakeRoom.last!.grant([]);
    await vi.waitFor(() => expect(mic.stopped).toBe(true));
    expect(denoiser.closed).toBe(true);
    expect(useVoiceStore.getState().listenOnly).toBe(true);
    expect(useVoiceStore.getState().serverMuted).toBe(false);
  });

  it("gives the microphone back muted when listen-only is switched off", async () => {
    setListenOnly(true);
    await useVoiceStore.getState().join("s1", "p1");
    const room = FakeRoom.last!;
    setListenOnly(false);
    room.grant([2]);
    await vi.waitFor(() => expect(room.published).toHaveLength(1));
    await vi.waitFor(() => expect(room.published[0].isMuted).toBe(true));
    expect(micRequests).toBe(1);
    expect(useVoiceStore.getState().listenOnly).toBe(false);
  });
});

/** Минимальный DOM и WebAudio: элементы <audio> и узлы графа как простые объекты. */
class FakeAudioEl {
  muted = false;
  volume = 1;
  autoplay = false;
  srcObject: unknown = null;
  removed = false;
  remove() {
    this.removed = true;
  }
  play = vi.fn(async () => {});
}
const createdAudio: FakeAudioEl[] = [];
const audioBox = { appendChild: () => {} };
vi.stubGlobal("document", {
  getElementById: () => audioBox,
  createElement: () => {
    const el = new FakeAudioEl();
    createdAudio.push(el);
    return el;
  },
  body: { appendChild: () => {} },
});
const node = () => ({ connect: (n: unknown) => n, disconnect: vi.fn() });
const gains: { gain: { setTargetAtTime: ReturnType<typeof vi.fn> } }[] = [];
class FakeAudioContext {
  state = "running";
  currentTime = 0;
  createMediaStreamSource = () => node();
  createGain = () => {
    const g = { ...node(), context: this, gain: { setTargetAtTime: vi.fn() } };
    gains.push(g);
    return g;
  };
  createWaveShaper = () => ({ ...node(), curve: null, oversample: "none" });
  createMediaStreamDestination = () => ({ ...node(), stream: {} });
  resume = async () => {};
  close = async () => {};
}
vi.stubGlobal("AudioContext", FakeAudioContext);
vi.stubGlobal("MediaStream", class {});

describe("peer volume", () => {
  function subscribe(userId: string) {
    const el = new FakeAudioEl();
    const track = {
      kind: "audio",
      sid: `TR_${userId}`,
      mediaStreamTrack: {},
      attach: () => el,
      detach: () => [el],
    };
    FakeRoom.last!.emit("TrackSubscribed", track, {}, { identity: userId });
    return { el, track };
  }

  beforeEach(() => {
    memoryStorage.clear();
    createdAudio.length = 0;
    gains.length = 0;
    useVoiceStore.setState({ volumes: {} });
  });

  it("turns one person down without touching the others and remembers it", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const loud = subscribe("loud");
    const other = subscribe("other");
    useVoiceStore.getState().setPeerVolume("loud", 0.4);
    expect(loud.el.volume).toBe(0.4);
    expect(loud.el.muted).toBe(false);
    expect(other.el.volume).toBe(1);
    expect(createdAudio).toHaveLength(0);
    expect(JSON.parse(memoryStorage.get("quazar_peer_volumes")!)).toEqual({ loud: 0.4 });
  });

  it("boosts a quiet person through WebAudio and mutes the plain element", async () => {
    await useVoiceStore.getState().join("s1", "p1");
    const quiet = subscribe("quiet");
    useVoiceStore.getState().setPeerVolume("quiet", 1.8);
    expect(quiet.el.muted).toBe(true);
    expect(createdAudio).toHaveLength(1);
    expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.9, 0, expect.any(Number));

    // Обратно к 100 % — усилитель убираем, звук снова идёт напрямую.
    useVoiceStore.getState().setPeerVolume("quiet", 1);
    expect(createdAudio[0].removed).toBe(true);
    expect(quiet.el.muted).toBe(false);
    expect(quiet.el.volume).toBe(1);
    expect(memoryStorage.has("quazar_peer_volumes")).toBe(false);
  });

  it("applies the saved volume as soon as the person is heard", async () => {
    useVoiceStore.getState().setPeerVolume("quiet", 2.5);
    expect(useVoiceStore.getState().volumes.quiet).toBe(2);
    await useVoiceStore.getState().join("s1", "p1");
    const quiet = subscribe("quiet");
    await vi.waitFor(() => expect(quiet.el.muted).toBe(true));
    expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, expect.any(Number));

    await useVoiceStore.getState().leave();
    expect(createdAudio[0].removed).toBe(true);
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

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeTrack {
  enabled = true;
  stopped = false;
  constraints: MediaTrackConstraints[] = [];
  constructor(
    readonly kind: "audio" | "video",
    readonly id: string
  ) {}
  async applyConstraints(c: MediaTrackConstraints) {
    this.constraints.push(c);
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

class FakeSender {
  constructor(public track: FakeTrack | null) {}
  async replaceTrack(t: FakeTrack) {
    this.track = t;
  }
}

class FakePeerConnection {
  senders: FakeSender[] = [];
  onicecandidate = null;
  ontrack = null;
  onconnectionstatechange = null;
  addTrack(track: FakeTrack) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  close() {}
}

/** Подмена RNNoise: в тестах важна проводка треков, а не DSP. */
class FakeDenoiser {
  static instances: FakeDenoiser[] = [];
  static fail = false;
  readonly track = new FakeTrack("audio", "denoised");
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

vi.mock("../noiseSuppression", () => ({
  isNoiseSuppressionSupported: () => true,
  preloadNoiseSuppression: () => Promise.resolve(new ArrayBuffer(0)),
  setBrowserNoiseSuppression: async (track: FakeTrack, enabled: boolean) => {
    await track.applyConstraints({ noiseSuppression: enabled });
  },
  NoiseSuppressedMic: {
    create: async () => {
      if (FakeDenoiser.fail) return null;
      const d = new FakeDenoiser();
      FakeDenoiser.instances.push(d);
      return d;
    },
  },
}));

const { CallPeer } = await import("../peer");

let mic: FakeTrack;
let lastConstraints: MediaStreamConstraints | null;

function makePeer(noiseSuppression: boolean) {
  const onNoiseSuppression = vi.fn();
  const peer = new CallPeer(
    [],
    { audio: true, video: false },
    {
      onIceCandidate: () => {},
      onRemoteStream: () => {},
      onConnectionState: () => {},
      onError: () => {},
      onNoiseSuppression,
    },
    noiseSuppression
  );
  return { peer, onNoiseSuppression };
}

function sentAudio(pc: FakePeerConnection) {
  return pc.senders.find((s) => s.track?.kind === "audio")?.track;
}

let pcs: FakePeerConnection[];

beforeEach(() => {
  FakeDenoiser.instances = [];
  FakeDenoiser.fail = false;
  pcs = [];
  mic = new FakeTrack("audio", "mic");
  lastConstraints = null;
  vi.stubGlobal("RTCPeerConnection", function () {
    const pc = new FakePeerConnection();
    pcs.push(pc);
    return pc;
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async (c: MediaStreamConstraints) => {
        lastConstraints = c;
        return new FakeStream([mic]);
      },
    },
  });
});

describe("CallPeer noise suppression", () => {
  it("sends the denoised track and disables browser noise suppression", async () => {
    const { peer, onNoiseSuppression } = makePeer(true);
    await peer.ensurePeer();

    expect((lastConstraints!.audio as MediaTrackConstraints).noiseSuppression).toBe(false);
    expect(sentAudio(pcs[0])?.id).toBe("denoised");
    expect(peer.isNoiseSuppressionActive()).toBe(true);
    expect(onNoiseSuppression).toHaveBeenLastCalledWith(true);
  });

  it("falls back to the browser processing when RNNoise is unavailable", async () => {
    FakeDenoiser.fail = true;
    const { peer, onNoiseSuppression } = makePeer(true);
    await peer.ensurePeer();

    expect(sentAudio(pcs[0])?.id).toBe("mic");
    expect(mic.constraints[mic.constraints.length - 1]).toEqual({ noiseSuppression: true });
    expect(onNoiseSuppression).toHaveBeenLastCalledWith(false);
  });

  it("keeps the browser processing when the setting is off", async () => {
    const { peer } = makePeer(false);
    await peer.ensurePeer();

    expect((lastConstraints!.audio as MediaTrackConstraints).noiseSuppression).toBe(true);
    expect(sentAudio(pcs[0])?.id).toBe("mic");
    expect(FakeDenoiser.instances).toHaveLength(0);
  });

  it("toggles during a call without renegotiation", async () => {
    const { peer } = makePeer(true);
    await peer.ensurePeer();
    const denoiser = FakeDenoiser.instances[0];

    expect(await peer.setNoiseSuppression(false)).toBe(false);
    expect(denoiser.enabled).toBe(false);
    expect(mic.constraints[mic.constraints.length - 1]).toEqual({ noiseSuppression: true });
    expect(sentAudio(pcs[0])?.id).toBe("denoised");

    expect(await peer.setNoiseSuppression(true)).toBe(true);
    expect(denoiser.enabled).toBe(true);
  });

  it("can be switched on mid-call and keeps the mute state", async () => {
    const { peer } = makePeer(false);
    await peer.ensurePeer();
    peer.setMuted(true);

    expect(await peer.setNoiseSuppression(true)).toBe(true);
    const sent = sentAudio(pcs[0])!;
    expect(sent.id).toBe("denoised");
    expect(sent.enabled).toBe(false);

    peer.setMuted(false);
    expect(sent.enabled).toBe(true);
  });

  it("returns to the raw microphone if audio processing stops", async () => {
    const { peer, onNoiseSuppression } = makePeer(true);
    await peer.ensurePeer();
    const denoiser = FakeDenoiser.instances[0];
    peer.setMuted(true);

    denoiser.onFailed!();
    await vi.waitFor(() => expect(sentAudio(pcs[0])?.id).toBe("mic"));
    expect(mic.enabled).toBe(false);
    expect(denoiser.closed).toBe(true);
    expect(onNoiseSuppression).toHaveBeenLastCalledWith(false);
  });

  it("switches the microphone mid-call keeping noise suppression and mute", async () => {
    const { peer } = makePeer(true);
    await peer.ensurePeer();
    const first = FakeDenoiser.instances[0];
    peer.setMuted(true);

    const usb = new FakeTrack("audio", "usb-mic");
    mic = usb;
    await peer.switchMicrophone();
    const second = FakeDenoiser.instances[1];
    expect(sentAudio(pcs[0])).toBe(second.track);
    expect(second.track.enabled).toBe(false); // выключенный микрофон остался выключенным
    expect(first.closed).toBe(true);
    expect(peer.isNoiseSuppressionActive()).toBe(true);

    peer.setMuted(false);
    expect(second.track.enabled).toBe(true);
  });

  it("switches the microphone without noise suppression too", async () => {
    const { peer } = makePeer(false);
    await peer.ensurePeer();
    const old = mic;
    mic = new FakeTrack("audio", "usb-mic");
    await peer.switchMicrophone();
    expect(sentAudio(pcs[0])?.id).toBe("usb-mic");
    expect(old.stopped).toBe(true);
  });

  it("releases the microphone on close", async () => {
    const { peer } = makePeer(true);
    await peer.ensurePeer();
    const denoiser = FakeDenoiser.instances[0];

    peer.close();
    expect(denoiser.closed).toBe(true);
    expect(mic.stopped).toBe(true);
  });
});

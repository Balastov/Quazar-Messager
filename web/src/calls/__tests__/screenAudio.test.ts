import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureScreen } from "../screenCapture";
import { CallPeer, screenAudioMid } from "../peer";

class Track extends EventTarget {
  enabled = true;
  readyState = "live";
  contentHint = "";
  constructor(readonly kind: "audio" | "video", readonly id: string) { super(); }
  stop() { this.readyState = "ended"; }
  async applyConstraints() {}
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  addTrack(track: Track) { this.tracks.push(track); }
  removeTrack(track: Track) { this.tracks = this.tracks.filter((value) => value !== track); }
}
class Transceiver {
  mid: string | null = null;
  direction = "sendrecv";
  currentDirection: string | null = null;
  receiver: { track: Track };
  sender: { track: Track | null; replaceTrack: ReturnType<typeof vi.fn> };
  constructor(kind: "audio" | "video", track: Track | null = null) {
    this.receiver = { track: new Track(kind, `remote-${Math.random()}`) };
    this.sender = { track, replaceTrack: vi.fn(async (value: Track | null) => { this.sender.track = value; }) };
  }
}
class PeerConnection {
  static last: PeerConnection;
  tracks: Transceiver[] = [];
  localDescription: (RTCSessionDescriptionInit & { toJSON: () => RTCSessionDescriptionInit }) | null = null;
  ontrack: ((event: { track: Track; transceiver: Transceiver; streams: Stream[] }) => void) | null = null;
  onicecandidate = null;
  onconnectionstatechange = null;
  signalingState = "stable";
  constructor() { PeerConnection.last = this; }
  addTrack(track: Track) { return this.addTransceiver(track).sender; }
  addTransceiver(track: Track | "audio" | "video") {
    const transceiver = new Transceiver(typeof track === "string" ? track : track.kind, typeof track === "string" ? null : track);
    this.tracks.push(transceiver); return transceiver;
  }
  getTransceivers() { return this.tracks; }
  getSenders() { return this.tracks.map((track) => track.sender); }
  description(type: "offer" | "answer"): RTCSessionDescriptionInit {
    this.tracks.forEach((track, index) => { track.mid ??= String(index); });
    return { type, sdp: "v=0\r\n" + this.tracks.map((track) => `m=${track.receiver.track.kind} 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:${track.mid}\r\n`).join("") };
  }
  async createOffer() { return this.description("offer"); }
  async createAnswer() { return this.description("answer"); }
  async setLocalDescription(value: RTCSessionDescriptionInit) {
    this.localDescription = { ...value, toJSON: () => value };
    if (value.type === "answer") this.tracks.forEach((track) => { track.currentDirection = track.direction; });
  }
  async setRemoteDescription(value: RTCSessionDescriptionInit) {
    for (const section of value.sdp?.split(/(?=^m=)/m) ?? []) {
      const kind = section.match(/^m=(audio|video) /)?.[1] as "audio" | "video" | undefined;
      const mid = section.match(/^a=mid:([^\r\n]+)/m)?.[1];
      if (!kind || !mid) continue;
      let track = this.tracks.find((candidate) => candidate.mid === mid) ??
        this.tracks.find((candidate) => candidate.mid === null && candidate.receiver.track.kind === kind);
      if (!track) { track = this.addTransceiver(kind); track.direction = "recvonly"; }
      track.mid = mid;
    }
    if (value.type === "answer") this.tracks.forEach((track) => { track.currentDirection = track.direction; });
  }
  async addIceCandidate() {}
  close() { this.signalingState = "closed"; }
}

let mic: Track, video: Track, sound: Track;
let display: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mic = new Track("audio", "microphone"); video = new Track("video", "screen"); sound = new Track("audio", "screen-audio");
  display = vi.fn(async () => new Stream([video, sound]));
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCPeerConnection", PeerConnection);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => new Stream([mic])), getDisplayMedia: display } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function callbacks() {
  return { onIceCandidate: vi.fn(), onRemoteStream: vi.fn(), onRemoteScreenAudio: vi.fn(),
    onConnectionState: vi.fn(), onError: vi.fn(), onLocalScreenAudioEnded: vi.fn() };
}
async function caller() {
  const events = callbacks();
  const peer = new CallPeer([], { audio: true, video: false }, events);
  const offer = await peer.createOffer();
  await peer.handleRemoteAnswer({ ...offer, type: "answer" });
  return { peer, events, pc: PeerConnection.last };
}

describe("screen capture sound", () => {
  it("requests source audio only after explicit opt-in and stops unexpected audio when declined", async () => {
    const stream = await captureScreen(false);
    expect(display).toHaveBeenCalledWith(expect.objectContaining({ audio: false, systemAudio: "exclude", windowAudio: "exclude" }));
    expect(sound.readyState).toBe("ended");
    expect(stream.getAudioTracks()).toEqual([]);
    expect(mic.readyState).toBe("live");
  });
  it("offers sound for supported screen, window and tab sources without requesting a microphone", async () => {
    const stream = await captureScreen(true, "motion");
    expect(display).toHaveBeenCalledWith(expect.objectContaining({ audio: true, systemAudio: "include", windowAudio: "window" }));
    expect(stream.getAudioTracks()[0]).toBe(sound);
    expect(video.contentHint).toBe("motion");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it("stops all captured resources if no video track was returned", async () => {
    display.mockResolvedValue(new Stream([sound]));
    await expect(captureScreen(true)).rejects.toThrow("Экран не выбран");
    expect(sound.readyState).toBe("ended");
  });
});

describe("separate audio in 1:1 calls", () => {
  it("reserves a separate screen audio channel and does not mute it with the microphone", async () => {
    const { peer, pc } = await caller();
    expect(pc.tracks.filter((track) => track.receiver.track.kind === "audio")).toHaveLength(2);
    await peer.startScreen(true);
    peer.setMuted(true);
    expect(mic.enabled).toBe(false);
    expect(sound.enabled).toBe(true);
    expect(peer.getLocalStream()?.getAudioTracks()).toEqual([mic]);
    expect(peer.isScreenAudioEnabled()).toBe(true);
    peer.setScreenAudioEnabled(false);
    expect(sound.enabled).toBe(false);
    peer.setMuted(false);
    expect(mic.enabled).toBe(true);
    expect(sound.enabled).toBe(false);
    peer.setScreenAudioEnabled(true);
    expect(sound.enabled).toBe(true);
    peer.close();
    expect(sound.readyState).toBe("ended");
  });
  it("separates received screen sound even when the event stream contains all audio tracks", async () => {
    const { pc, events } = await caller();
    const audio = pc.tracks.filter((track) => track.receiver.track.kind === "audio");
    const remoteMic = new Track("audio", "remote-mic"), remoteSound = new Track("audio", "remote-screen");
    const combined = new Stream([remoteMic, remoteSound]);
    pc.ontrack?.({ track: remoteSound, transceiver: audio[1], streams: [combined] });
    pc.ontrack?.({ track: remoteMic, transceiver: audio[0], streams: [combined] });
    expect(events.onRemoteScreenAudio.mock.calls[0][0].getAudioTracks()).toEqual([remoteSound]);
    expect(events.onRemoteStream.mock.calls[0][0].getAudioTracks()).toEqual([remoteMic]);
  });
  it("stops source audio when screen video is replaced or the browser stops the audio track", async () => {
    const { peer, pc, events } = await caller();
    await peer.startScreen(true);
    sound.end();
    expect(peer.hasScreenAudioCapture()).toBe(false);
    expect(events.onLocalScreenAudioEnded).toHaveBeenCalledOnce();
    expect(pc.tracks.filter((track) => track.receiver.track.kind === "audio")[1].sender.track).toBeNull();
    await peer.setOutgoingVideo(null);
    expect(video.readyState).toBe("ended");
  });
  it("cleans up capture without altering the microphone if publishing audio fails", async () => {
    const { peer, pc } = await caller();
    pc.tracks.filter((track) => track.receiver.track.kind === "audio")[1].sender.replaceTrack.mockRejectedValueOnce(new Error("failed"));
    await expect(peer.startScreen(true)).rejects.toThrow("failed");
    expect(video.readyState).toBe("ended");
    expect(sound.readyState).toBe("ended");
    expect(mic.readyState).toBe("live");
    expect(peer.hasScreenAudioCapture()).toBe(false);
  });
  it("recognizes legacy peers without a second audio channel", async () => {
    const peer = new CallPeer([], { audio: true, video: false }, callbacks());
    await peer.handleRemoteOffer({ type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\n" });
    expect(peer.canSendScreenAudio()).toBe(false);
    await expect(peer.startScreen(true)).rejects.toThrow("не поддерживает");
    expect(display).not.toHaveBeenCalled();
  });
  it("accepts an incoming reserved audio channel for bidirectional sharing", async () => {
    const peer = new CallPeer([], { audio: true, video: false }, callbacks());
    await peer.handleRemoteOffer({ type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:2\r\n" });
    expect(peer.canSendScreenAudio()).toBe(true);
    expect(screenAudioMid(PeerConnection.last.localDescription!.sdp!)).toBe("2");
    await peer.startScreen(true);
    expect(peer.isScreenAudioEnabled()).toBe(true);
  });

  it("keeps the two audio sections distinct even in a video-only call", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(new Stream([new Track("video", "camera")]) as unknown as MediaStream);
    const peer = new CallPeer([], { audio: false, video: true }, callbacks());
    const offer = await peer.createOffer();
    expect(PeerConnection.last.tracks.filter((track) => track.receiver.track.kind === "audio")).toHaveLength(2);
    expect(screenAudioMid(offer.sdp!)).not.toBeNull();
    await peer.handleRemoteAnswer({ ...offer, type: "answer" });
    await peer.startScreen(true);
    peer.setMuted(true);
    expect(sound.enabled).toBe(true);
    expect(peer.getLocalStream()?.getAudioTracks()).toEqual([]);
  });
});

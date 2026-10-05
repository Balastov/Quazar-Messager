import type { CallMedia, IceServer } from "../api/types";

export type PeerCallbacks = {
  onIceCandidate: (candidate: RTCIceCandidateInit | null) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onError: (message: string) => void;
};

/**
 * WebRTC peer for 1:1 audio / video calls.
 * Signaling stays the same; `media.video` selects camera at invite time.
 */
export class CallPeer {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private facingMode: "user" | "environment" = "user";

  constructor(
    private iceServers: IceServer[],
    private media: CallMedia,
    private cb: PeerCallbacks
  ) {}

  getLocalStream() {
    return this.localStream;
  }

  getRemoteStream() {
    return this.remoteStream;
  }

  getMedia() {
    return this.media;
  }

  private rtcIceServers(): RTCIceServer[] {
    return this.iceServers.map((s) => ({
      urls: s.urls,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }));
  }

  private mediaConstraints(): MediaStreamConstraints {
    return {
      audio: this.media.audio !== false,
      video:
        this.media.video === true
          ? {
              facingMode: this.facingMode,
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
    };
  }

  async startLocalMedia(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia(this.mediaConstraints());
    this.localStream = stream;
    return stream;
  }

  async ensurePeer(): Promise<RTCPeerConnection> {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({ iceServers: this.rtcIceServers() });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      this.cb.onIceCandidate(ev.candidate ? ev.candidate.toJSON() : null);
    };

    pc.ontrack = (ev) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      const incoming = ev.streams[0]?.getTracks() ?? [ev.track];
      for (const track of incoming) {
        const exists = this.remoteStream.getTracks().some((t) => t.id === track.id);
        if (!exists) this.remoteStream.addTrack(track);
      }
      this.cb.onRemoteStream(this.remoteStream);
    };

    pc.onconnectionstatechange = () => {
      this.cb.onConnectionState(pc.connectionState);
    };

    if (!this.localStream) {
      await this.startLocalMedia();
    }
    for (const track of this.localStream!.getTracks()) {
      pc.addTrack(track, this.localStream!);
    }

    return pc;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const pc = await this.ensurePeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return pc.localDescription!.toJSON();
  }

  async handleRemoteOffer(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const pc = await this.ensurePeer();
    await pc.setRemoteDescription(sdp);
    this.remoteSet = true;
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription!.toJSON();
  }

  async handleRemoteAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = await this.ensurePeer();
    await pc.setRemoteDescription(sdp);
    this.remoteSet = true;
    await this.flushIce();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) return;
    if (!this.pc || !this.remoteSet) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      if (this.pc.signalingState !== "closed") {
        console.warn("addIceCandidate failed", err);
      }
    }
  }

  setMuted(muted: boolean) {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  setCameraEnabled(enabled: boolean) {
    this.localStream?.getVideoTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  /** Switch front/back camera on devices that support it. */
  async flipCamera(): Promise<MediaStream | null> {
    if (!this.media.video || !this.pc || !this.localStream) return this.localStream;

    const nextFacing = this.facingMode === "user" ? "environment" : "user";
    let newStream: MediaStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { exact: nextFacing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch {
      // exact facingMode often fails on desktop — soft fallback
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: nextFacing,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    }

    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return this.localStream;

    const oldTrack = this.localStream.getVideoTracks()[0];
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(newTrack);
    }

    if (oldTrack) {
      this.localStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    this.localStream.addTrack(newTrack);
    this.facingMode = nextFacing;
    // Stop leftover audio-less stream container tracks already moved
    newStream.getTracks().forEach((t) => {
      if (t !== newTrack) t.stop();
    });

    return this.localStream;
  }

  close() {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.remoteStream = null;
    this.pendingIce = [];
    this.remoteSet = false;
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
  }

  private async flushIce() {
    const pc = this.pc;
    if (!pc) return;
    const queued = this.pendingIce.splice(0);
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        // ignore
      }
    }
  }
}

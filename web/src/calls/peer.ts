import type { CallMedia, IceServer } from "../api/types";

export type PeerCallbacks = {
  onIceCandidate: (candidate: RTCIceCandidateInit | null) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onError: (message: string) => void;
};

/**
 * Thin WebRTC wrapper. Audio-first; video tracks can be added later via
 * `upgradeToVideo()` without changing the signaling protocol.
 */
export class CallPeer {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;

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

  private rtcIceServers(): RTCIceServer[] {
    return this.iceServers.map((s) => ({
      urls: s.urls,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }));
  }

  async startLocalMedia(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: this.media.audio !== false,
      video: this.media.video === true,
    });
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
      for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
        this.remoteStream.addTrack(track);
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
      // Ignore late candidates after hangup / glare
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

  /** Future: upgrade audio call to video without new call_id. */
  async upgradeToVideo(): Promise<void> {
    if (!this.pc) throw new Error("No peer connection");
    const cam = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const track = cam.getVideoTracks()[0];
    if (!track) throw new Error("No video track");
    this.localStream?.addTrack(track);
    this.pc.addTrack(track, this.localStream!);
    this.media = { ...this.media, video: true };
    // Caller will renegotiate via createOffer in a later phase.
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

import {
  mediaDevices,
  MediaStream,
  MediaStreamTrack,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import type {
  CallMedia,
  IceCandidateInit,
  IceServer,
  SessionDescriptionInit,
} from '../api/types';

export type PeerCallbacks = {
  onIceCandidate: (candidate: IceCandidateInit | null) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionState: (state: string) => void;
  onError: (message: string) => void;
};

type RNPeerConnection = RTCPeerConnection & {
  addEventListener?: (type: string, listener: (ev: any) => void) => void;
  connectionState?: string;
};

/**
 * WebRTC peer for React Native (react-native-webrtc).
 * Same signaling contract as the web client.
 */
export class CallPeer {
  private pc: RNPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingIce: IceCandidateInit[] = [];
  private remoteSet = false;
  private facingMode: 'user' | 'environment' = 'user';

  constructor(
    private iceServers: IceServer[],
    private media: CallMedia,
    private cb: PeerCallbacks,
  ) {}

  getLocalStream() {
    return this.localStream;
  }

  getRemoteStream() {
    return this.remoteStream;
  }

  private rtcIceServers() {
    return this.iceServers.map(s => ({
      urls: s.urls,
      ...(s.username ? {username: s.username} : {}),
      ...(s.credential ? {credential: s.credential} : {}),
    }));
  }

  async startLocalMedia(): Promise<MediaStream> {
    const stream = (await mediaDevices.getUserMedia({
      audio: this.media.audio !== false,
      video:
        this.media.video === true
          ? {
              facingMode: this.facingMode,
              width: 1280,
              height: 720,
              frameRate: 30,
            }
          : false,
    })) as MediaStream;
    this.localStream = stream;
    return stream;
  }

  async ensurePeer(): Promise<RNPeerConnection> {
    if (this.pc) {
      return this.pc;
    }

    const pc = new RTCPeerConnection({
      iceServers: this.rtcIceServers(),
    }) as RNPeerConnection;
    this.pc = pc;

    const onIce = (ev: {candidate?: RTCIceCandidate | null}) => {
      const c = ev.candidate;
      if (!c) {
        this.cb.onIceCandidate(null);
        return;
      }
      this.cb.onIceCandidate({
        candidate: c.candidate,
        sdpMLineIndex: c.sdpMLineIndex,
        sdpMid: c.sdpMid,
      });
    };

    const onTrack = (ev: {streams?: MediaStream[]; track?: MediaStreamTrack}) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      const tracks =
        ev.streams?.[0]?.getTracks?.() ?? (ev.track ? [ev.track] : []);
      for (const track of tracks) {
        const exists = this.remoteStream
          .getTracks()
          .some((t: MediaStreamTrack) => t.id === track.id);
        if (!exists) {
          this.remoteStream.addTrack(track);
        }
      }
      this.cb.onRemoteStream(this.remoteStream);
    };

    const onState = () => {
      this.cb.onConnectionState(pc.connectionState ?? 'new');
    };

    if (typeof pc.addEventListener === 'function') {
      pc.addEventListener('icecandidate', onIce);
      pc.addEventListener('track', onTrack);
      pc.addEventListener('connectionstatechange', onState);
    } else {
      // Older RN WebRTC style
      (pc as any).onicecandidate = onIce;
      (pc as any).ontrack = onTrack;
      (pc as any).onconnectionstatechange = onState;
    }

    if (!this.localStream) {
      await this.startLocalMedia();
    }
    for (const track of this.localStream!.getTracks()) {
      pc.addTrack(track, this.localStream!);
    }

    return pc;
  }

  async createOffer(): Promise<SessionDescriptionInit> {
    const pc = await this.ensurePeer();
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    const local = pc.localDescription;
    return {type: local?.type as SessionDescriptionInit['type'], sdp: local?.sdp};
  }

  async handleRemoteOffer(
    sdp: SessionDescriptionInit,
  ): Promise<SessionDescriptionInit> {
    const pc = await this.ensurePeer();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp as any));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const local = pc.localDescription;
    return {type: local?.type as SessionDescriptionInit['type'], sdp: local?.sdp};
  }

  async handleRemoteAnswer(sdp: SessionDescriptionInit): Promise<void> {
    const pc = await this.ensurePeer();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp as any));
    this.remoteSet = true;
    await this.flushIce();
  }

  async addIceCandidate(candidate: IceCandidateInit | null): Promise<void> {
    if (!candidate?.candidate) {
      return;
    }
    if (!this.pc || !this.remoteSet) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate as any));
    } catch (err) {
      console.warn('addIceCandidate failed', err);
    }
  }

  setMuted(muted: boolean) {
    this.localStream?.getAudioTracks().forEach((t: MediaStreamTrack) => {
      t.enabled = !muted;
    });
  }

  setCameraEnabled(enabled: boolean) {
    this.localStream?.getVideoTracks().forEach((t: MediaStreamTrack) => {
      t.enabled = enabled;
    });
  }

  async flipCamera(): Promise<MediaStream | null> {
    if (!this.media.video || !this.localStream) {
      return this.localStream;
    }
    const videoTrack = this.localStream.getVideoTracks()[0] as
      | (MediaStreamTrack & {_switchCamera?: () => void})
      | undefined;
    if (videoTrack && typeof videoTrack._switchCamera === 'function') {
      videoTrack._switchCamera();
      this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
      return this.localStream;
    }
    return this.localStream;
  }

  close() {
    this.localStream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    this.localStream = null;
    this.remoteStream = null;
    this.pendingIce = [];
    this.remoteSet = false;
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  private async flushIce() {
    const pc = this.pc;
    if (!pc) {
      return;
    }
    const queued = this.pendingIce.splice(0);
    for (const c of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c as any));
      } catch {
        // ignore
      }
    }
  }
}

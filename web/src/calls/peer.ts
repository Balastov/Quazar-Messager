import type { CallMedia, IceServer } from "../api/types";
import { captureScreen } from "./screenCapture";
import { getMicrophone, getPreferredInput } from "./devices";
import {
  isNoiseSuppressionSupported,
  NoiseSuppressedMic,
  preloadNoiseSuppression,
  setBrowserNoiseSuppression,
} from "./noiseSuppression";

export type PeerCallbacks = {
  onIceCandidate: (candidate: RTCIceCandidateInit | null) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteScreenAudio?: (stream: MediaStream) => void;
  onLocalScreenAudioEnded?: () => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onError: (message: string) => void;
  /** Работает ли сейчас шумоподавление RNNoise для микрофона. */
  onNoiseSuppression?: (active: boolean) => void;
};

/**
 * WebRTC peer for 1:1 audio / video calls.
 * Signaling stays the same; `media.video` selects camera at invite time.
 *
 * Камеру и показ экрана можно включить посреди разговора, в том числе в аудиозвонке: звонящий
 * всегда заводит видеоканал (addTransceiver, sendrecv), а принимающий разрешает в нём отправку.
 * Дальше камера или экран просто подставляются в этот канал (replaceTrack) — без нового
 * offer/answer. Собеседнику о смене сообщает сигнал call_media.
 * Звук экрана использует вторую аудиосекцию SDP; микрофон и трансляция не смешиваются.
 */
export class CallPeer {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteScreenStream: MediaStream | null = null;
  private screenAudioSender: RTCRtpTransceiver | null = null;
  private remoteScreenAudioMid: string | null = null;
  private screenAudioTrack: MediaStreamTrack | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private facingMode: "user" | "environment" = "user";
  /** Исходный трек микрофона, пока собеседнику уходит очищенный RNNoise. */
  private rawAudioTrack: MediaStreamTrack | null = null;
  private denoiser: NoiseSuppressedMic | null = null;

  constructor(
    private iceServers: IceServer[],
    private media: CallMedia,
    private cb: PeerCallbacks,
    private noiseSuppression = false
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

  private wantsDenoiser(): boolean {
    return this.noiseSuppression && this.media.audio !== false && isNoiseSuppressionSupported();
  }

  private mediaConstraints(): MediaStreamConstraints {
    const audio: MediaTrackConstraints | false =
      this.media.audio !== false
        ? {
            echoCancellation: true,
            autoGainControl: true,
            // Пока работает RNNoise, встроенное шумоподавление выключено — без двойной обработки.
            noiseSuppression: !this.wantsDenoiser(),
            // Выбранный микрофон; если его нет — браузер возьмёт системный.
            ...(getPreferredInput() ? { deviceId: { ideal: getPreferredInput() } } : {}),
          }
        : false;
    return {
      audio,
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
    const wantsDenoiser = this.wantsDenoiser();
    // Модель грузится параллельно с запросом доступа к микрофону.
    if (wantsDenoiser) void preloadNoiseSuppression().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia(this.mediaConstraints());
    this.localStream = stream;
    if (wantsDenoiser) {
      await this.attachDenoiser();
    }
    return stream;
  }

  /** Выбрали другой микрофон — подменяем отправляемый трек без пересогласования звонка. */
  async switchMicrophone(): Promise<void> {
    if (!this.localStream || this.media.audio === false) return;
    const oldOut = this.denoiser?.track ?? this.localStream.getAudioTracks()[0];
    if (!oldOut) return;
    const oldRaw = this.denoiser ? this.rawAudioTrack : oldOut;
    const oldDenoiser = this.denoiser;
    const wasEnabled = oldOut.enabled;

    const wantsDenoiser = this.wantsDenoiser();
    const stream = await getMicrophone({
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: !wantsDenoiser,
    });
    const raw = stream.getAudioTracks()[0];
    if (!raw) return;
    const denoiser = wantsDenoiser ? await NoiseSuppressedMic.create(raw) : null;
    if (wantsDenoiser && !denoiser) await setBrowserNoiseSuppression(raw, true);
    if (denoiser) denoiser.onFailed = () => void this.detachDenoiser();
    const newOut = denoiser?.track ?? raw;
    newOut.enabled = wasEnabled; // выключенный микрофон остаётся выключенным

    await this.swapAudioTrack(oldOut, newOut);
    this.denoiser = denoiser;
    this.rawAudioTrack = denoiser ? raw : null;
    oldDenoiser?.close();
    oldRaw?.stop();
    this.cb.onNoiseSuppression?.(denoiser !== null);
  }

  isNoiseSuppressionActive(): boolean {
    return this.denoiser !== null;
  }

  /**
   * Вкл/выкл шумоподавление во время звонка. Возвращает, работает ли RNNoise после вызова
   * (false при включении — устройство не поддерживает, остаётся обработка браузера).
   */
  async setNoiseSuppression(enabled: boolean): Promise<boolean> {
    this.noiseSuppression = enabled;
    if (!this.localStream) return false;

    if (this.denoiser && this.rawAudioTrack) {
      this.denoiser.setEnabled(enabled);
      await setBrowserNoiseSuppression(this.rawAudioTrack, !enabled);
      return enabled;
    }
    if (!enabled) return false;
    return this.attachDenoiser();
  }

  /** Пропускает микрофон через RNNoise и подменяет отправляемый трек. */
  private async attachDenoiser(): Promise<boolean> {
    const raw = this.localStream?.getAudioTracks()[0];
    if (!raw || this.denoiser) return this.denoiser !== null;

    const denoiser = await NoiseSuppressedMic.create(raw);
    if (!denoiser || !this.localStream) {
      denoiser?.close();
      await setBrowserNoiseSuppression(raw, true);
      this.cb.onNoiseSuppression?.(false);
      return false;
    }

    await setBrowserNoiseSuppression(raw, false);
    // Выключенный микрофон остаётся выключенным: mute управляет отправляемым треком.
    denoiser.track.enabled = raw.enabled;
    raw.enabled = true;
    denoiser.onFailed = () => void this.detachDenoiser();

    await this.swapAudioTrack(raw, denoiser.track);
    this.rawAudioTrack = raw;
    this.denoiser = denoiser;
    this.cb.onNoiseSuppression?.(true);
    return true;
  }

  /** Возврат к исходному микрофону (аудио на устройстве остановилось и не перезапускается). */
  private async detachDenoiser(): Promise<void> {
    const { denoiser, rawAudioTrack: raw } = this;
    if (!denoiser || !raw) return;
    this.denoiser = null;
    this.rawAudioTrack = null;

    raw.enabled = denoiser.track.enabled;
    await setBrowserNoiseSuppression(raw, true);
    await this.swapAudioTrack(denoiser.track, raw);
    denoiser.close();
    this.cb.onNoiseSuppression?.(false);
  }

  private async swapAudioTrack(from: MediaStreamTrack, to: MediaStreamTrack): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track === from);
    if (sender) await sender.replaceTrack(to);
    if (this.localStream) {
      this.localStream.removeTrack(from);
      this.localStream.addTrack(to);
    }
  }

  async ensurePeer(): Promise<RTCPeerConnection> {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({ iceServers: this.rtcIceServers() });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      this.cb.onIceCandidate(ev.candidate ? ev.candidate.toJSON() : null);
    };

    pc.ontrack = (ev) => {
      if (this.pc !== pc) return;
      const screenAudio = ev.track.kind === "audio" &&
        (ev.transceiver === this.screenAudioSender || (!!this.remoteScreenAudioMid && ev.transceiver.mid === this.remoteScreenAudioMid));
      if (screenAudio) {
        this.remoteScreenStream ??= new MediaStream();
        if (!this.remoteScreenStream.getTracks().some((track) => track.id === ev.track.id)) this.remoteScreenStream.addTrack(ev.track);
        this.cb.onRemoteScreenAudio?.(new MediaStream(this.remoteScreenStream.getTracks()));
      } else {
        this.remoteStream ??= new MediaStream();
        if (!this.remoteStream.getTracks().some((track) => track.id === ev.track.id)) this.remoteStream.addTrack(ev.track);
        // У каждого события новый объект: React обновит srcObject и при позднем аудиотреке.
        this.cb.onRemoteStream(new MediaStream(this.remoteStream.getTracks()));
      }
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
    // Даже video-only звонок сохраняет первую аудиосекцию для микрофона:
    // вторая всегда однозначно обозначает звук демонстрации.
    if (!pc.getTransceivers().some((track) => track.receiver.track?.kind === "audio")) pc.addTransceiver("audio", { direction: "sendrecv" });
    // Аудиозвонок: пустой видеоканал, чтобы потом включить камеру или экран без пересогласования.
    if (!this.videoTransceiver()) pc.addTransceiver("video", { direction: "sendrecv" });
    this.screenAudioSender ??= pc.addTransceiver("audio", { direction: "sendrecv" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return pc.localDescription!.toJSON();
  }

  /** Пересобрать ICE-маршрут после смены сети (новый offer тем же каналом сигналинга). */
  async restartIce(): Promise<RTCSessionDescriptionInit | null> {
    const pc = this.pc;
    if (!pc || pc.signalingState === "closed") return null;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    return pc.localDescription!.toJSON();
  }

  connectionState(): RTCPeerConnectionState | null {
    return this.pc?.connectionState ?? null;
  }

  async handleRemoteOffer(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const pc = await this.ensurePeer();
    this.remoteScreenAudioMid = screenAudioMid(sdp.sdp ?? "");
    await pc.setRemoteDescription(sdp);
    this.remoteSet = true;
    await this.flushIce();
    // Видеоканал из offer, в который нам пока нечего слать, — разрешаем и отправку.
    const video = this.videoTransceiver();
    if (video && video.direction === "recvonly") video.direction = "sendrecv";
    this.screenAudioSender = this.remoteScreenAudioMid ? pc.getTransceivers().find((track) => track.mid === this.remoteScreenAudioMid) ?? null : null;
    if (this.screenAudioSender && this.screenAudioSender.direction === "recvonly") this.screenAudioSender.direction = "sendrecv";
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription!.toJSON();
  }

  async handleRemoteAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = await this.ensurePeer();
    this.remoteScreenAudioMid = screenAudioMid(sdp.sdp ?? "");
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

  private videoTransceiver(): RTCRtpTransceiver | null {
    return (
      this.pc
        ?.getTransceivers()
        .find((t) => t.receiver.track?.kind === "video" && t.currentDirection !== "stopped") ?? null
    );
  }

  /** Можно ли сейчас слать видео: видеоканал есть и согласован на отправку. */
  canSendVideo(): boolean {
    const dir = this.videoTransceiver()?.currentDirection;
    return dir === "sendrecv" || dir === "sendonly";
  }

  /** Подставить в видеоканал камеру, экран или ничего (null). Прежняя дорожка останавливается. */
  async setOutgoingVideo(track: MediaStreamTrack | null, keepScreenAudio = false): Promise<void> {
    const transceiver = this.videoTransceiver();
    if (!transceiver || !this.localStream) throw new Error("Видео в этом звонке недоступно");
    await transceiver.sender.replaceTrack(track);
    if (!keepScreenAudio) await this.stopScreenAudio();
    for (const old of this.localStream.getVideoTracks()) {
      if (old === track) continue;
      this.localStream.removeTrack(old);
      old.stop();
    }
    if (track && !this.localStream.getVideoTracks().includes(track)) this.localStream.addTrack(track);
  }

  /** Включить камеру посреди разговора. */
  async startCamera(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: this.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    await this.setOutgoingVideo(stream.getVideoTracks()[0] ?? null);
  }

  /** Показ экрана: возвращает дорожку (её «ended» — человек нажал «Закрыть доступ» в браузере). */
  async startScreen(shareAudio = false): Promise<MediaStreamTrack> {
    if (shareAudio && !this.canSendScreenAudio()) throw new Error("Собеседник не поддерживает отдельный звук трансляции");
    const stream = await captureScreen(shareAudio);
    const track = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] ?? null;
    try {
      if (audio && this.screenAudioSender) {
        await this.screenAudioSender.sender.replaceTrack(audio);
        this.screenAudioTrack = audio;
        audio.addEventListener("ended", () => {
          if (this.screenAudioTrack !== audio) return;
          void this.stopScreenAudio();
          this.cb.onLocalScreenAudioEnded?.();
        }, { once: true });
      }
      await this.setOutgoingVideo(track, true);
    } catch (error) {
      await this.stopScreenAudio();
      stream.getTracks().forEach((captured) => captured.stop());
      throw error;
    }
    return track;
  }

  canSendScreenAudio(): boolean {
    const direction = this.screenAudioSender?.currentDirection;
    return direction === "sendrecv" || direction === "sendonly";
  }

  hasScreenAudioCapture(): boolean {
    return !!this.screenAudioTrack && this.screenAudioTrack.readyState !== "ended";
  }

  isScreenAudioEnabled(): boolean {
    return this.hasScreenAudioCapture() && !!this.screenAudioTrack?.enabled;
  }

  setScreenAudioEnabled(enabled: boolean): void {
    if (this.hasScreenAudioCapture()) this.screenAudioTrack!.enabled = enabled;
  }

  private async stopScreenAudio(): Promise<void> {
    const track = this.screenAudioTrack;
    this.screenAudioTrack = null;
    track?.stop();
    await this.screenAudioSender?.sender.replaceTrack(null).catch(() => {});
  }

  /** Switch front/back camera on devices that support it. */
  async flipCamera(): Promise<MediaStream | null> {
    if (!this.pc || !this.localStream?.getVideoTracks().length) return this.localStream;

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
    const screenAudio = this.screenAudioTrack;
    this.screenAudioTrack = null;
    screenAudio?.stop();
    this.screenAudioSender = null;
    this.remoteScreenStream = null;
    this.remoteScreenAudioMid = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.denoiser?.close();
    this.denoiser = null;
    this.rawAudioTrack?.stop();
    this.rawAudioTrack = null;
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

/** В наших offer первая аудиосекция — микрофон, вторая — звук демонстрации. */
export function screenAudioMid(sdp: string): string | null {
  const audio = sdp.split(/(?=^m=)/m).filter((section) => section.startsWith("m=audio "));
  return audio[1]?.match(/^a=mid:([^\r\n]+)/m)?.[1] ?? null;
}

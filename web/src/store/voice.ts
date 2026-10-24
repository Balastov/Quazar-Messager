/**
 * Голос на Планетах (Созвездие) через медиасервер LiveKit.
 *
 * Микрофон проходит через то же шумоподавление RNNoise, что и в звонках.
 * Одновременно можно быть только на одной Планете и не в личном звонке.
 *
 * Показ экрана: на Планете показывает не больше одного человека. Токен LiveKit разрешает
 * публиковать только микрофон; право на экран выдаёт бэкенд (POST …/screen) и отзывает,
 * когда показ закончен — тогда LiveKit сам снимает трек.
 *
 * Планета «Только слушать»: микрофон не открываем вообще (браузер его даже не запрашивает),
 * сервер и не пустит. Режим могут переключить на ходу — тогда микрофон освобождаем или
 * возвращаем выключенным.
 *
 * Громкость собеседников: у каждого своя (см. calls/peerVolume) — на микрофон и звук экрана.
 */
import type {
  LocalTrack,
  LocalTrackPublication,
  Participant,
  RemoteTrack,
  Room,
  Track,
} from "livekit-client";
import { create } from "zustand";
import axios from "axios";
import { starsApi } from "../api/stars";
import {
  getNoiseSuppressionPref,
  isNoiseSuppressionSupported,
  NoiseSuppressedMic,
  preloadNoiseSuppression,
  setBrowserNoiseSuppression,
  setNoiseSuppressionPref,
} from "../calls/noiseSuppression";
import { applyIosRoute, applyOutput, getMicrophone, getPreferredOutput } from "../calls/devices";
import {
  Amplifier,
  clampVolume,
  closeAmplifiers,
  loadPeerVolumes,
  needsAmplifier,
  resumeAmplifiers,
  savePeerVolumes,
  type PeerVolumes,
} from "../calls/peerVolume";
import { useCallStore } from "./call";
import { roomWords, type RoomWords } from "../components/constellation/words";
import { playStarSound } from "../sounds/starSounds";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";

export interface VoicePeer {
  userId: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micOn: boolean;
  screenSharing: boolean;
}

/** Видео показа экрана, которое сейчас есть в комнате. */
export interface VoiceScreen {
  userId: string;
  isLocal: boolean;
  track: Track;
}

interface VoiceState {
  status: VoiceStatus;
  starId: string | null;
  channelId: string | null;
  peers: VoicePeer[];
  micOn: boolean;
  /** Микрофон недоступен — можно только слушать. */
  micUnavailable: boolean;
  /** Почему микрофон недоступен и что сделать (показывается на экране Планеты). */
  micError: string | null;
  /** Модератор выключил микрофон. */
  serverMuted: boolean;
  /** Планета «Только слушать»: микрофон не используется. */
  listenOnly: boolean;
  /** Треки показа экрана в комнате (обычно один). */
  screens: VoiceScreen[];
  /** Я показываю экран. */
  sharingScreen: boolean;
  /** Выбираем экран / занимаем слот. */
  screenStarting: boolean;
  noiseSuppression: boolean;
  noiseActive: boolean;
  /** Громкость собеседников по userId (нет записи — 100 %). */
  volumes: PeerVolumes;
  /** Браузер не дал включить звук без нажатия. */
  needsAudioUnlock: boolean;
  error: string | null;
  notice: string | null;
  /** Комната «По приглашениям» не пустила — нужно постучаться. */
  locked: { starId: string; channelId: string } | null;

  join: (starId: string, channelId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMic: () => Promise<void>;
  /** Ещё раз попросить микрофон, не выходя с Планеты. */
  retryMic: () => Promise<void>;
  /** Выбрали другой микрофон — подменяем отправляемый трек на ходу. */
  switchMicrophone: () => Promise<void>;
  /** Выбрали другой динамик — переводим звук собеседников. */
  applyOutput: () => Promise<void>;
  toggleNoise: () => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  unlockAudio: () => Promise<void>;
  /** 0…2: громкость одного собеседника, запоминается на устройстве. */
  setPeerVolume: (userId: string, volume: number) => void;
  dismissNotice: () => void;
}

interface Mic {
  raw: MediaStreamTrack;
  denoiser: NoiseSuppressedMic | null;
  publication: LocalTrackPublication | null;
}

type LiveKit = typeof import("livekit-client");

/** enum TrackSource протокола LiveKit — в permissions.canPublishSources приходят числа. */
const PROTO_SOURCE = { microphone: 2, screen_share: 3 } as const;

/** Та же проверка, что делает LiveKit перед публикацией (hasPermissionsToPublish). */
function canPublishSource(p: Participant, source: keyof typeof PROTO_SOURCE): boolean {
  const perms = p.permissions;
  if (!perms) return source === "microphone";
  const sources = (perms.canPublishSources ?? []) as unknown as number[];
  return perms.canPublish && (sources.length === 0 || sources.includes(PROTO_SOURCE[source]));
}

/** Показ экрана есть только в десктопных браузерах. */
export function canShareScreen(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

/** Почему не удалось начать показ экрана. null — человек сам закрыл выбор экрана. */
export function screenErrorText(err: unknown): string | null {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "";
  if (name === "NotAllowedError" && /system/i.test(message)) {
    return (
      "Система не дала браузеру записывать экран. На Mac: Системные настройки → " +
      "Конфиденциальность и безопасность → Запись экрана и системного звука → включите ваш " +
      "браузер и перезапустите его."
    );
  }
  if (name === "NotAllowedError" || name === "AbortError") return null;
  if (name === "NotReadableError") return "Не удалось захватить экран — попробуйте выбрать другое окно";
  return "Не удалось начать показ экрана. Попробуйте ещё раз.";
}

/** Библиотека LiveKit (~600 КБ) грузится только при входе на Планету. */
let lk: LiveKit | null = null;
let room: Room | null = null;
let mic: Mic | null = null;
/** Отписка от стора Созвездия (следим за режимом «Только слушать» текущей Планеты). */
let unwatchPlanet: (() => void) | null = null;
/** Сами останавливаем показ — не пишем «остановил модератор». */
let stoppingScreen = false;
/** Мы сами вышли — не показываем «связь прервалась». */
let leavingOnPurpose = false;

/** Звук собеседника, который сейчас играет: по sid трека. */
interface PlayedAudio {
  userId: string;
  track: RemoteTrack;
  elements: HTMLMediaElement[];
  /** Громкость не 100 % там, где элемент сам так не умеет. */
  amp: Amplifier | null;
}
const played = new Map<string, PlayedAudio>();

function audioContainer(): HTMLElement {
  let el = document.getElementById("quazar-voice-audio");
  if (!el) {
    el = document.createElement("div");
    el.id = "quazar-voice-audio";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

/** Выставляет громкость. false — усилитель не заиграл без нажатия. */
async function applyVolume(audio: PlayedAudio, volume: number): Promise<boolean> {
  if (needsAmplifier(volume)) {
    audio.amp ??= new Amplifier(audio.track.mediaStreamTrack, audioContainer());
    audio.amp.setVolume(volume);
    // Исходный элемент играет беззвучно: без него Chrome не отдаёт звук в WebAudio.
    for (const el of audio.elements) el.muted = true;
    return audio.amp.play();
  }
  audio.amp?.close();
  audio.amp = null;
  for (const el of audio.elements) {
    el.volume = volume;
    el.muted = false;
  }
  return true;
}

function attachAudio(track: RemoteTrack, userId: string, volume: number): Promise<boolean> {
  if (track.kind !== "audio" || !track.sid) return Promise.resolve(true);
  const elements = track.attach();
  const list = (Array.isArray(elements) ? elements : [elements]) as HTMLMediaElement[];
  for (const el of list) {
    audioContainer().appendChild(el);
    void applyOutput(el);
  }
  const audio: PlayedAudio = { userId, track, elements: list, amp: null };
  played.set(track.sid, audio);
  return volume === 1 ? Promise.resolve(true) : applyVolume(audio, volume);
}

function detachAudio(track: RemoteTrack) {
  track.detach().forEach((el) => el.remove());
  if (!track.sid) return;
  played.get(track.sid)?.amp?.close();
  played.delete(track.sid);
}

function peerOf(p: Participant, isLocal: boolean): VoicePeer {
  return {
    userId: p.identity,
    name: p.name || p.identity,
    isLocal,
    speaking: p.isSpeaking,
    micOn: p.isMicrophoneEnabled,
    screenSharing: p.isScreenShareEnabled,
  };
}

/** Захваченные треки экрана, которые мы публикуем (видео и, если дали, звук). */
function localScreenTracks(r: Room): LocalTrack[] {
  const out: LocalTrack[] = [];
  for (const pub of r.localParticipant.trackPublications.values()) {
    if (pub.track && (pub.source === "screen_share" || pub.source === "screen_share_audio")) {
      out.push(pub.track);
    }
  }
  return out;
}

/** Понятная причина, почему не удалось взять микрофон, и что с этим сделать. */
export function micErrorText(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "Браузер не дал доступ к микрофону. Разрешите его: значок слева от адреса сайта → " +
        "«Микрофон» → «Разрешить». На Mac проверьте ещё: Системные настройки → " +
        "Конфиденциальность и безопасность → Микрофон → включите ваш браузер."
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return "Микрофон не найден. Подключите гарнитуру или проверьте, что микрофон включён в системе.";
    case "NotReadableError":
    case "AbortError":
      return (
        "Микрофон занят другой программой (Zoom, Телемост, другая вкладка с звонком). " +
        "Закройте её и нажмите «Включить микрофон»."
      );
    default: {
      const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
      return `Не удалось включить микрофон${detail}. Нажмите «Включить микрофон», чтобы попробовать ещё раз.`;
    }
  }
}

function apiError(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string") return detail;
  }
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return "Нет доступа к микрофону — разрешите его в настройках браузера";
  }
  return fallback;
}

type StarsStore = typeof import("./stars").useStarsStore;

/** Стор Созвездия — динамически: иначе цикл импортов (stars → auth → voice). */
async function starsStore(): Promise<StarsStore> {
  return (await import("./stars")).useStarsStore;
}

let words: RoomWords | null = null;
/** Переходим на другую Планету — звук выхода не играем, будет звук входа. */
let switchingPlace = false;
/** Чтобы несколько человек, вошедших разом, не дали какофонию. */
let lastPeerSound = 0;

function peerSound(event: "peerJoin" | "peerLeave") {
  const now = Date.now();
  if (now - lastPeerSound < 700) return;
  lastPeerSound = now;
  void playStarSound(event);
}

/** Формулировки текущей Планеты/Комнаты (тип Звезды и название — из стора Созвездия). */
async function wordsFor(starId: string, channelId: string): Promise<RoomWords> {
  const detail = (await starsStore()).getState().details[starId];
  const name = detail?.channels.find((c) => c.id === channelId)?.name ?? "";
  return roomWords(detail?.kind, name);
}

function planetListenOnly(stars: StarsStore, starId: string, channelId: string): boolean {
  const channel = stars.getState().details[starId]?.channels.find((c) => c.id === channelId);
  return !!channel?.listen_only;
}

async function releaseMic() {
  if (!mic) return;
  mic.denoiser?.close();
  mic.raw.stop();
  mic = null;
}

export const useVoiceStore = create<VoiceState>((set, get) => {
  function syncPeers() {
    if (!room) {
      set({ peers: [] });
      return;
    }
    const local = peerOf(room.localParticipant, true);
    const remote = [...room.remoteParticipants.values()].map((p) => peerOf(p, false));
    const screens: VoiceScreen[] = [];
    const localScreen = room.localParticipant.getTrackPublication(lk!.Track.Source.ScreenShare);
    if (localScreen?.track) {
      screens.push({ userId: room.localParticipant.identity, isLocal: true, track: localScreen.track });
    }
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(lk!.Track.Source.ScreenShare);
      if (pub?.track) screens.push({ userId: p.identity, isLocal: false, track: pub.track });
    }
    set({
      peers: [local, ...remote.sort((a, b) => a.name.localeCompare(b.name, "ru"))],
      micOn: local.micOn,
      screens,
      sharingScreen: !!localScreen?.track,
    });
  }

  /** Право на экран приходит от LiveKit чуть позже ответа бэкенда — ждём его. */
  function waitForScreenPermission(r: Room): Promise<void> {
    if (canPublishSource(r.localParticipant, "screen_share")) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        r.off(lk!.RoomEvent.ParticipantPermissionsChanged, onChange);
        reject(new Error("screen permission timeout"));
      }, 5000);
      function onChange() {
        if (!canPublishSource(r.localParticipant, "screen_share")) return;
        clearTimeout(timer);
        r.off(lk!.RoomEvent.ParticipantPermissionsChanged, onChange);
        resolve();
      }
      r.on(lk!.RoomEvent.ParticipantPermissionsChanged, onChange);
    });
  }

  /** Показ закончился (сами, кнопкой браузера или модератор): гасим захват, отпускаем слот. */
  function onLocalUnpublished(pub: LocalTrackPublication) {
    if (pub.source !== "screen_share" && pub.source !== "screen_share_audio") return;
    pub.track?.stop();
    if (pub.source !== "screen_share" || !room) return;
    const r = room;
    // Звук экрана без картинки не нужен.
    for (const track of localScreenTracks(r)) void r.localParticipant.unpublishTrack(track);
    const { starId, channelId } = get();
    if (starId && channelId) void starsApi.stopScreen(starId, channelId).catch(() => {});
  }

  async function publishMic(r: Room) {
    if (!mic) return;
    const track = mic.denoiser?.track ?? mic.raw;
    mic.publication = await r.localParticipant.publishTrack(track, {
      source: lk!.Track.Source.Microphone,
      name: "microphone",
      dtx: true,
    });
  }

  async function cleanup(notice: string | null = null) {
    const r = room;
    room = null;
    unwatchPlanet?.();
    unwatchPlanet = null;
    if (r) {
      r.removeAllListeners();
      const screenTracks = localScreenTracks(r);
      await r.disconnect().catch(() => {});
      // stopLocalTrackOnUnpublish: false — захват экрана гасим сами.
      screenTracks.forEach((t) => t.stop());
    }
    for (const audio of played.values()) {
      audio.amp?.close();
      audio.elements.forEach((el) => el.remove());
    }
    played.clear();
    closeAmplifiers();
    await releaseMic();
    set({
      status: "idle",
      starId: null,
      channelId: null,
      peers: [],
      micOn: false,
      micUnavailable: false,
      micError: null,
      serverMuted: false,
      listenOnly: false,
      screens: [],
      sharingScreen: false,
      screenStarting: false,
      noiseActive: false,
      needsAudioUnlock: false,
      ...(notice ? { notice } : {}),
    });
  }

  /** RNNoise выдаёт тишину или аудио остановилось — переключаемся на обычный микрофон. */
  function watchDenoiser(denoiser: NoiseSuppressedMic) {
    denoiser.onFailed = (reason) => {
      if (!mic || mic.denoiser !== denoiser) return;
      void mic.publication?.audioTrack?.replaceTrack(mic.raw, true);
      void setBrowserNoiseSuppression(mic.raw, true);
      denoiser.close();
      mic.denoiser = null;
      set({
        noiseActive: false,
        ...(reason === "silent"
          ? {
              notice:
                "Шумоподавление не заработало на этом устройстве — включён обычный микрофон, вас слышно",
            }
          : {}),
      });
    };
  }

  /** Микрофон (выбранный или системный) и, если можно, RNNoise поверх него. */
  async function openMicrophone(): Promise<{ raw: MediaStreamTrack; denoiser: NoiseSuppressedMic | null }> {
    const wantDenoiser = get().noiseSuppression && isNoiseSuppressionSupported();
    const stream = await getMicrophone({
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: !wantDenoiser,
    });
    const raw = stream.getAudioTracks()[0];
    if (!raw) throw new DOMException("no audio track", "NotFoundError");
    const denoiser = wantDenoiser ? await NoiseSuppressedMic.create(raw) : null;
    if (wantDenoiser && !denoiser) await setBrowserNoiseSuppression(raw, true);
    return { raw, denoiser };
  }

  /** Берёт микрофон (через RNNoise, если можно) и публикует его. Ошибку объясняет на экране. */
  async function acquireMic(r: Room, { startMuted = false } = {}) {
    try {
      const { raw, denoiser } = await openMicrophone();
      if (room !== r) {
        denoiser?.close();
        raw.stop();
        return;
      }
      mic = { raw, denoiser, publication: null };
      if (denoiser) watchDenoiser(denoiser);
      await publishMic(r);
      if (startMuted) await mic?.publication?.mute();
      set({ noiseActive: !!denoiser, micUnavailable: false, micError: null });
    } catch (err) {
      console.error("Planet microphone failed", err);
      await releaseMic();
      set({ micUnavailable: true, micError: micErrorText(err) });
    }
  }

  let acquiringAfterListenOnly = false;

  /** Режим «Только слушать» включили или выключили, пока мы на Планете. */
  async function applyListenOnly(r: Room, listenOnly: boolean) {
    if (room !== r) return;
    set({ listenOnly });
    if (listenOnly) {
      // Сервер снимет трек сам; мы освобождаем устройство — гаснет индикатор микрофона.
      await releaseMic();
      set({ micUnavailable: false, micError: null, noiseActive: false, serverMuted: false });
      syncPeers();
      return;
    }
    await restoreMicAfterListenOnly(r);
  }

  /** Режим выключили: как только сервер разрешит, берём микрофон — выключенным. */
  async function restoreMicAfterListenOnly(r: Room) {
    if (room !== r || get().listenOnly || mic || acquiringAfterListenOnly) return;
    if (!canPublishSource(r.localParticipant, "microphone")) return;
    acquiringAfterListenOnly = true;
    try {
      await acquireMic(r, { startMuted: true });
    } finally {
      acquiringAfterListenOnly = false;
    }
    syncPeers();
  }

  /** Громкость всем, кто сейчас звучит (после разблокировки звука LiveKit снимает mute). */
  async function applyVolumes() {
    const { volumes } = get();
    const results = await Promise.all(
      [...played.values()].map((audio) => applyVolume(audio, volumes[audio.userId] ?? 1))
    );
    if (results.includes(false)) set({ needsAudioUnlock: true });
  }

  function wire(r: Room, { RoomEvent, DisconnectReason }: LiveKit) {
    r.on(RoomEvent.ParticipantConnected, () => {
      peerSound("peerJoin");
      syncPeers();
    })
      .on(RoomEvent.ParticipantDisconnected, () => {
        // При нашем собственном отключении LiveKit «отключает» и всех остальных — молчим.
        if (room === r && r.state === "connected") peerSound("peerLeave");
        syncPeers();
      })
      .on(RoomEvent.ActiveSpeakersChanged, syncPeers)
      .on(RoomEvent.TrackMuted, syncPeers)
      .on(RoomEvent.TrackUnmuted, syncPeers)
      .on(RoomEvent.LocalTrackPublished, syncPeers)
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        onLocalUnpublished(pub);
        syncPeers();
      })
      .on(RoomEvent.TrackPublished, syncPeers)
      .on(RoomEvent.TrackUnpublished, syncPeers)
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        void attachAudio(track, participant.identity, get().volumes[participant.identity] ?? 1).then((ok) => {
          if (!ok && room === r) set({ needsAudioUnlock: true });
        });
        syncPeers();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        detachAudio(track);
        syncPeers();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        set({ needsAudioUnlock: !r.canPlaybackAudio });
      })
      .on(RoomEvent.Reconnecting, () => set({ status: "reconnecting" }))
      .on(RoomEvent.Reconnected, () => {
        set({ status: "connected" });
        syncPeers();
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
        if (participant !== r.localParticipant) return;
        const micAllowed = canPublishSource(participant, "microphone");
        // В «Только слушать» микрофона нет ни у кого — это не мьют модератором.
        set({ serverMuted: !micAllowed && !get().listenOnly });
        if (micAllowed && !mic) void restoreMicAfterListenOnly(r);
        // Модератор вернул микрофон — публикуем его снова (выключенным, включит сам человек).
        if (micAllowed && mic && !mic.publication) {
          void publishMic(r)
            .then(() => mic?.publication?.mute())
            .then(syncPeers);
        }
        if (!micAllowed && mic) mic.publication = null;
        // Право на экран отозвали, а мы его не останавливали — это модератор.
        // Трек LiveKit снимет сам; на всякий случай снимаем и мы.
        if (!canPublishSource(participant, "screen_share") && !stoppingScreen) {
          const screenTracks = localScreenTracks(r);
          if (screenTracks.length) {
            set({ notice: "Модератор остановил ваш показ экрана" });
            for (const track of screenTracks) void r.localParticipant.unpublishTrack(track);
          }
        }
        syncPeers();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== r) return;
        let notice: string | null = null;
        if (!leavingOnPurpose) {
          void playStarSound("leave");
          const w = words ?? roomWords(undefined, "");
          if (reason === DisconnectReason.PARTICIPANT_REMOVED) notice = w.removed;
          else if (reason === DisconnectReason.ROOM_DELETED) notice = w.closed;
          else if (reason === DisconnectReason.DUPLICATE_IDENTITY) notice = w.otherDevice;
          else notice = w.lost;
        }
        void cleanup(notice);
      });
  }

  return {
    status: "idle",
    starId: null,
    channelId: null,
    peers: [],
    micOn: false,
    micUnavailable: false,
    micError: null,
    serverMuted: false,
    listenOnly: false,
    screens: [],
    sharingScreen: false,
    screenStarting: false,
    noiseSuppression: getNoiseSuppressionPref(),
    noiseActive: false,
    volumes: loadPeerVolumes(),
    needsAudioUnlock: false,
    error: null,
    notice: null,
    locked: null,

    join: async (starId, channelId) => {
      const { status, channelId: current } = get();
      if (current === channelId && status !== "idle") return;
      const callPhase = useCallStore.getState().phase;
      if (callPhase !== "idle" && callPhase !== "ended") {
        set({ error: "Сначала завершите звонок" });
        return;
      }
      if (status !== "idle") {
        switchingPlace = true;
        try {
          await get().leave();
        } finally {
          switchingPlace = false;
        }
      }

      set({ status: "connecting", starId, channelId, error: null, notice: null, locked: null });
      const roomText = await wordsFor(starId, channelId);
      words = roomText;
      applyIosRoute(); // iPhone: «у уха» или громкая связь — до того, как пойдёт звук
      const wantDenoiser = get().noiseSuppression && isNoiseSuppressionSupported();
      if (wantDenoiser) void preloadNoiseSuppression().catch(() => {});

      let r: Room;
      try {
        lk ??= await import("livekit-client");
      } catch {
        await cleanup();
        set({ error: "Не удалось загрузить модуль голосовой связи. Проверьте интернет." });
        return;
      }
      r = new lk.Room({
        // Показ экрана: зрителю приходит слой качества по размеру окна, ненужные слои
        // у показывающего выключаются.
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
        // Когда модератор выключает микрофон, сервер снимает трек с публикации. Трек не
        // останавливаем: его вернут, а освобождаем микрофон сами при выходе (releaseMic).
        stopLocalTrackOnUnpublish: false,
      });
      leavingOnPurpose = false;
      try {
        const { url, token } = await starsApi.joinPlanet(starId, channelId);
        room = r;
        wire(r, lk);
        await r.connect(url, token);
      } catch (err) {
        await cleanup();
        if (axios.isAxiosError(err) && err.response?.status === 423) {
          set({ locked: { starId, channelId } });
          return;
        }
        set({ error: apiError(err, roomText.failed) });
        return;
      }

      // «Только слушать» — микрофон не трогаем вовсе. Следим, не переключат ли режим.
      const stars = await starsStore();
      const listenOnly = planetListenOnly(stars, starId, channelId);
      set({ listenOnly });
      unwatchPlanet = stars.subscribe((st) => {
        const next = !!st.details[starId]?.channels.find((c) => c.id === channelId)?.listen_only;
        if (next !== get().listenOnly) void applyListenOnly(r, next);
      });

      // Микрофон. Если его нет или не разрешили — остаёмся слушать, причину покажем на экране.
      if (!listenOnly) await acquireMic(r);

      await r.startAudio().catch(() => {});
      set({ status: "connected", needsAudioUnlock: !r.canPlaybackAudio });
      await applyVolumes();
      syncPeers();
      void playStarSound("enter");
    },

    leave: async () => {
      leavingOnPurpose = true;
      if (!switchingPlace && get().status !== "idle") void playStarSound("leave");
      await cleanup();
    },

    toggleMic: async () => {
      const publication = mic?.publication;
      if (!publication || get().serverMuted) return;
      if (publication.isMuted) await publication.unmute();
      else await publication.mute();
      syncPeers();
    },

    switchMicrophone: async () => {
      const r = room;
      if (!r || get().status === "idle" || get().listenOnly) return;
      if (!mic) {
        // Микрофона не было (не разрешили) — пробуем взять выбранный.
        await acquireMic(r);
        syncPeers();
        return;
      }
      const old = mic;
      try {
        const next = await openMicrophone();
        if (room !== r || mic !== old) {
          next.denoiser?.close();
          next.raw.stop();
          return;
        }
        const track = next.denoiser?.track ?? next.raw;
        await old.publication?.audioTrack?.replaceTrack(track, true);
        if (next.denoiser) watchDenoiser(next.denoiser);
        mic = { raw: next.raw, denoiser: next.denoiser, publication: old.publication };
        old.denoiser?.close();
        old.raw.stop();
        set({ noiseActive: !!next.denoiser, micError: null });
      } catch (err) {
        set({ notice: micErrorText(err) });
      }
      syncPeers();
    },

    applyOutput: async () => {
      const deviceId = getPreferredOutput();
      for (const audio of played.values()) {
        for (const el of audio.elements) await applyOutput(el, deviceId);
        if (audio.amp) await applyOutput(audio.amp.output, deviceId);
      }
      await room?.switchActiveDevice("audiooutput", deviceId || "default").catch(() => {});
    },

    retryMic: async () => {
      const r = room;
      if (!r || get().status === "idle" || mic || get().listenOnly) return;
      set({ micError: null });
      await acquireMic(r);
      syncPeers();
    },

    toggleNoise: async () => {
      const next = !get().noiseSuppression;
      setNoiseSuppressionPref(next);
      set({ noiseSuppression: next });
      if (!mic) return;
      if (mic.denoiser) {
        mic.denoiser.setEnabled(next);
        await setBrowserNoiseSuppression(mic.raw, !next);
        set({ noiseActive: next });
        return;
      }
      if (!next) return;
      // Включили на ходу: подключаем RNNoise и подменяем отправляемый трек.
      const denoiser = await NoiseSuppressedMic.create(mic.raw);
      if (!denoiser || !mic) {
        denoiser?.close();
        return;
      }
      await setBrowserNoiseSuppression(mic.raw, false);
      mic.denoiser = denoiser;
      watchDenoiser(denoiser);
      await mic.publication?.audioTrack?.replaceTrack(denoiser.track, true);
      set({ noiseActive: true });
    },

    startScreenShare: async () => {
      const r = room;
      const { starId, channelId, status, sharingScreen, screenStarting } = get();
      if (!r || !lk || !starId || !channelId || status !== "connected") return;
      if (sharingScreen || screenStarting) return;
      set({ screenStarting: true });

      // Сначала выбор экрана: браузер разрешает его только сразу после нажатия кнопки.
      let tracks: LocalTrack[];
      try {
        tracks = await r.localParticipant.createScreenTracks({
          audio: true,
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          contentHint: "detail",
          resolution: lk.ScreenSharePresets.h1080fps15.resolution,
        });
      } catch (err) {
        set({ screenStarting: false });
        const text = screenErrorText(err);
        if (text) set({ notice: text });
        return;
      }

      const published: LocalTrack[] = [];
      try {
        await starsApi.startScreen(starId, channelId);
        await waitForScreenPermission(r);
        if (room !== r) throw new Error("left the planet");
        for (const track of tracks) {
          await r.localParticipant.publishTrack(track, {
            screenShareEncoding: lk.ScreenSharePresets.h1080fps15.encoding,
            // Текст на экране важнее плавности.
            degradationPreference: "maintain-resolution",
          });
          published.push(track);
        }
      } catch (err) {
        stoppingScreen = true;
        for (const track of published) await r.localParticipant.unpublishTrack(track).catch(() => {});
        stoppingScreen = false;
        tracks.forEach((t) => t.stop());
        if (room === r) {
          void starsApi.stopScreen(starId, channelId).catch(() => {});
          set({ notice: apiError(err, "Не удалось начать показ экрана. Попробуйте ещё раз.") });
        }
      }
      set({ screenStarting: false });
      syncPeers();
    },

    stopScreenShare: async () => {
      const r = room;
      if (!r) return;
      stoppingScreen = true;
      try {
        // Слот освобождает onLocalUnpublished (там же гасится захват).
        for (const track of localScreenTracks(r)) {
          await r.localParticipant.unpublishTrack(track).catch(() => {});
        }
      } finally {
        stoppingScreen = false;
      }
      syncPeers();
    },

    unlockAudio: async () => {
      // Усилители — первыми, пока нажатие ещё считается свежим.
      const amps = [...played.values()].map((audio) => audio.amp?.play());
      await resumeAmplifiers();
      await room?.startAudio().catch(() => {});
      await Promise.all(amps);
      set({ needsAudioUnlock: room ? !room.canPlaybackAudio : false });
      await applyVolumes();
    },

    setPeerVolume: (userId, volume) => {
      const v = clampVolume(volume);
      const volumes = { ...get().volumes };
      if (v === 1) delete volumes[userId];
      else volumes[userId] = v;
      savePeerVolumes(volumes);
      set({ volumes });
      for (const audio of played.values()) {
        if (audio.userId !== userId) continue;
        void applyVolume(audio, v).then((ok) => {
          if (!ok) set({ needsAudioUnlock: true });
        });
      }
    },

    dismissNotice: () => set({ notice: null, error: null, locked: null }),
  };
});

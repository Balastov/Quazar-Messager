/**
 * Голос на Планетах (Созвездие) через медиасервер LiveKit.
 *
 * Микрофон проходит через то же шумоподавление RNNoise, что и в звонках.
 * Одновременно можно быть только на одной Планете и не в личном звонке.
 */
import type {
  LocalTrackPublication,
  Participant,
  RemoteTrack,
  Room,
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
import { useCallStore } from "./call";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";

export interface VoicePeer {
  userId: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micOn: boolean;
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
  noiseSuppression: boolean;
  noiseActive: boolean;
  /** Браузер не дал включить звук без нажатия. */
  needsAudioUnlock: boolean;
  error: string | null;
  notice: string | null;

  join: (starId: string, channelId: string) => Promise<void>;
  leave: () => Promise<void>;
  toggleMic: () => Promise<void>;
  /** Ещё раз попросить микрофон, не выходя с Планеты. */
  retryMic: () => Promise<void>;
  toggleNoise: () => Promise<void>;
  unlockAudio: () => Promise<void>;
  dismissNotice: () => void;
}

interface Mic {
  raw: MediaStreamTrack;
  denoiser: NoiseSuppressedMic | null;
  publication: LocalTrackPublication | null;
}

type LiveKit = typeof import("livekit-client");

/** Библиотека LiveKit (~600 КБ) грузится только при входе на Планету. */
let lk: LiveKit | null = null;
let room: Room | null = null;
let mic: Mic | null = null;
/** Мы сами вышли — не показываем «связь прервалась». */
let leavingOnPurpose = false;
const audioElements = new Map<string, HTMLMediaElement[]>();

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

function attachAudio(track: RemoteTrack) {
  if (track.kind !== "audio" || !track.sid) return;
  const elements = track.attach();
  const list = Array.isArray(elements) ? elements : [elements];
  for (const el of list) audioContainer().appendChild(el);
  audioElements.set(track.sid, list as HTMLMediaElement[]);
}

function detachAudio(track: RemoteTrack) {
  track.detach().forEach((el) => el.remove());
  if (track.sid) audioElements.delete(track.sid);
}

function peerOf(p: Participant, isLocal: boolean): VoicePeer {
  return {
    userId: p.identity,
    name: p.name || p.identity,
    isLocal,
    speaking: p.isSpeaking,
    micOn: p.isMicrophoneEnabled,
  };
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
    set({
      peers: [local, ...remote.sort((a, b) => a.name.localeCompare(b.name, "ru"))],
      micOn: local.micOn,
    });
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
    if (r) {
      r.removeAllListeners();
      await r.disconnect().catch(() => {});
    }
    for (const els of audioElements.values()) els.forEach((el) => el.remove());
    audioElements.clear();
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

  /** Берёт микрофон (через RNNoise, если можно) и публикует его. Ошибку объясняет на экране. */
  async function acquireMic(r: Room) {
    const wantDenoiser = get().noiseSuppression && isNoiseSuppressionSupported();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: !wantDenoiser,
        },
      });
      const raw = stream.getAudioTracks()[0];
      if (!raw) throw new DOMException("no audio track", "NotFoundError");
      const denoiser = wantDenoiser ? await NoiseSuppressedMic.create(raw) : null;
      if (wantDenoiser && !denoiser) await setBrowserNoiseSuppression(raw, true);
      if (room !== r) {
        denoiser?.close();
        raw.stop();
        return;
      }
      mic = { raw, denoiser, publication: null };
      if (denoiser) watchDenoiser(denoiser);
      await publishMic(r);
      set({ noiseActive: !!denoiser, micUnavailable: false, micError: null });
    } catch (err) {
      console.error("Planet microphone failed", err);
      await releaseMic();
      set({ micUnavailable: true, micError: micErrorText(err) });
    }
  }

  function wire(r: Room, { RoomEvent, DisconnectReason }: LiveKit) {
    r.on(RoomEvent.ParticipantConnected, syncPeers)
      .on(RoomEvent.ParticipantDisconnected, syncPeers)
      .on(RoomEvent.ActiveSpeakersChanged, syncPeers)
      .on(RoomEvent.TrackMuted, syncPeers)
      .on(RoomEvent.TrackUnmuted, syncPeers)
      .on(RoomEvent.LocalTrackPublished, syncPeers)
      .on(RoomEvent.LocalTrackUnpublished, syncPeers)
      .on(RoomEvent.TrackPublished, syncPeers)
      .on(RoomEvent.TrackUnpublished, syncPeers)
      .on(RoomEvent.TrackSubscribed, (track) => {
        attachAudio(track);
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
        const canPublish = participant.permissions?.canPublish ?? true;
        set({ serverMuted: !canPublish });
        // Модератор вернул микрофон — публикуем его снова (выключенным, включит сам человек).
        if (canPublish && mic && !mic.publication) {
          void publishMic(r)
            .then(() => mic?.publication?.mute())
            .then(syncPeers);
        }
        if (!canPublish && mic) mic.publication = null;
        syncPeers();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== r) return;
        let notice: string | null = null;
        if (!leavingOnPurpose) {
          if (reason === DisconnectReason.PARTICIPANT_REMOVED) notice = "Вас вывели с Планеты";
          else if (reason === DisconnectReason.ROOM_DELETED) notice = "Планету закрыли";
          else if (reason === DisconnectReason.DUPLICATE_IDENTITY)
            notice = "Вы зашли на Планету с другого устройства";
          else notice = "Связь с Планетой прервалась";
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
    noiseSuppression: getNoiseSuppressionPref(),
    noiseActive: false,
    needsAudioUnlock: false,
    error: null,
    notice: null,

    join: async (starId, channelId) => {
      const { status, channelId: current } = get();
      if (current === channelId && status !== "idle") return;
      const callPhase = useCallStore.getState().phase;
      if (callPhase !== "idle" && callPhase !== "ended") {
        set({ error: "Сначала завершите звонок" });
        return;
      }
      if (status !== "idle") await get().leave();

      set({ status: "connecting", starId, channelId, error: null, notice: null });
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
        adaptiveStream: false,
        dynacast: false,
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
        set({ error: apiError(err, "Не удалось подключиться к Планете. Попробуйте ещё раз.") });
        return;
      }

      // Микрофон. Если его нет или не разрешили — остаёмся слушать, причину покажем на экране.
      await acquireMic(r);

      await r.startAudio().catch(() => {});
      set({ status: "connected", needsAudioUnlock: !r.canPlaybackAudio });
      syncPeers();
    },

    leave: async () => {
      leavingOnPurpose = true;
      await cleanup();
    },

    toggleMic: async () => {
      const publication = mic?.publication;
      if (!publication || get().serverMuted) return;
      if (publication.isMuted) await publication.unmute();
      else await publication.mute();
      syncPeers();
    },

    retryMic: async () => {
      const r = room;
      if (!r || get().status === "idle" || mic) return;
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

    unlockAudio: async () => {
      await room?.startAudio().catch(() => {});
      set({ needsAudioUnlock: room ? !room.canPlaybackAudio : false });
    },

    dismissNotice: () => set({ notice: null, error: null }),
  };
});

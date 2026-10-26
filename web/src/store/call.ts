import { create } from "zustand";
import { callsApi } from "../api/calls";
import type { CallHistoryItem, CallMedia, CallPhase, WsEvent } from "../api/types";
import { CallPeer } from "../calls/peer";
import { getNoiseSuppressionPref, setNoiseSuppressionPref } from "../calls/noiseSuppression";
import { applyIosRoute } from "../calls/devices";
import { clearCallNotification, notifyIncomingCall } from "../notifications/notify";
import { startCallRingtone, startConnectionLostTone } from "../notifications/sound";
import { socket } from "../ws/socket";
import { useAuthStore } from "./auth";
import { useChatStore } from "./chat";
import { useVoiceStore } from "./voice";
import { displayName } from "../utils/profile";

type EndReason =
  | "hangup"
  | "reject"
  | "busy"
  | "unavailable"
  | "error"
  | "failed"
  | "disconnect"
  | "timeout"
  | null;

/**
 * Связь прервалась посреди разговора: self — у нас нет сети, peer — у собеседника,
 * media — пропал звук, а чья сеть виновата, неизвестно.
 */
export type Reconnecting = "self" | "peer" | "media" | null;

interface CallState {
  phase: CallPhase;
  callId: string | null;
  chatId: string | null;
  peerUserId: string | null;
  peerUsername: string | null;
  peerAvatarUrl: string | null;
  media: CallMedia;
  muted: boolean;
  cameraOff: boolean;
  /** Настройка пользователя (запоминается на устройстве). */
  noiseSuppression: boolean;
  /** RNNoise реально обрабатывает микрофон в текущем звонке. */
  noiseSuppressionActive: boolean;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  /** Что я сейчас показываю собеседнику: камеру, экран или ничего. */
  localVideo: LocalVideo;
  /** Что показывает собеседник (по его сигналу call_media). */
  remoteVideo: RemoteVideo;
  error: string | null;
  endReason: EndReason;
  reconnecting: Reconnecting;
  /** Когда звонок завершится, если связь не вернётся (Date.now()). */
  reconnectDeadline: number | null;
  history: CallHistoryItem[];

  startAudioCall: (chatId: string, peerUserId: string) => Promise<void>;
  startVideoCall: (chatId: string, peerUserId: string) => Promise<void>;
  accept: () => Promise<void>;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleNoiseSuppression: () => Promise<void>;
  /** Выбрали другой микрофон в настройках устройств. */
  switchMicrophone: () => Promise<void>;
  /** Камера вкл/выкл — и в аудиозвонке тоже (звонок становится видео). */
  toggleCamera: () => Promise<void>;
  flipCamera: () => Promise<void>;
  /** Показ экрана вкл/выкл. */
  toggleScreenShare: () => Promise<void>;
  /** Можно ли в этом звонке включать видео (собеседник поддерживает, соединение готово). */
  canSendVideo: () => boolean;
  loadHistory: () => Promise<void>;
  clearEnded: () => void;
  prepareIncomingFromPush: (info: {
    callId: string;
    chatId: string;
    callerId?: string | null;
    callerName?: string | null;
    media?: CallMedia | null;
  }) => void;
}

export type LocalVideo = "camera" | "screen" | null;
export interface RemoteVideo {
  video: boolean;
  screen: boolean;
}

/** Видео в начале звонка: видеозвонок — камеры с обеих сторон, аудио — ничего. */
function initialVideo(media: CallMedia): { localVideo: LocalVideo; remoteVideo: RemoteVideo; cameraOff: boolean } {
  return {
    localVideo: media.video ? "camera" : null,
    remoteVideo: { video: !!media.video, screen: false },
    cameraOff: !media.video,
  };
}

/** До экрана была камера — по окончании показа вернуть её. */
let cameraBeforeScreen = false;

let peer: CallPeer | null = null;
let endClearTimer: ReturnType<typeof setTimeout> | null = null;
let stopRingtone: (() => void) | null = null;

/** Сколько ждём возвращения связи посреди звонка (столько же ждёт сервер). */
export const RECONNECT_GRACE_MS = 10_000;
const HEARTBEAT_MS = 2500;
const PONG_TIMEOUT_MS = 6000;
const RESTART_THROTTLE_MS = 3000;

/** Id вкладки: по нему сервер узнаёт вернувшееся устройство. */
const deviceId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Звонок начали мы — значит, и маршрут после обрыва пересобираем мы (без встречных offer). */
let iAmCaller = false;
let selfOffline = false;
let peerLost = false;
let mediaLost = false;
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPong = 0;
let lastRestartAt = 0;
let stopLostTone: (() => void) | null = null;

function inCall(): boolean {
  const phase = useCallStore.getState().phase;
  return phase === "connecting" || phase === "active";
}

function updateReconnecting() {
  const st = useCallStore.getState();
  const reason: Reconnecting =
    st.phase !== "active"
      ? null
      : selfOffline
        ? "self"
        : peerLost
          ? "peer"
          : mediaLost
            ? "media"
            : null;

  // Мягкие сигналы — только тому, у кого пропала сеть.
  if (reason === "self") {
    if (!stopLostTone) stopLostTone = startConnectionLostTone();
  } else {
    stopLostTone?.();
    stopLostTone = null;
  }

  if (reason && !graceTimer) {
    graceTimer = setTimeout(onReconnectExpired, RECONNECT_GRACE_MS);
    useCallStore.setState({ reconnecting: reason, reconnectDeadline: Date.now() + RECONNECT_GRACE_MS });
  } else if (!reason && graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
    useCallStore.setState({ reconnecting: null, reconnectDeadline: null });
  } else if (reason !== st.reconnecting) {
    useCallStore.setState({ reconnecting: reason });
  }
}

function onReconnectExpired() {
  graceTimer = null;
  const { callId, reconnecting } = useCallStore.getState();
  if (callId) socket.send({ type: "call_hangup", call_id: callId, reason: "disconnect" });
  finishCall(
    "disconnect",
    reconnecting === "self" ? "Нет связи — звонок завершён" : "Связь прервалась"
  );
}

function resetReconnect() {
  selfOffline = false;
  peerLost = false;
  mediaLost = false;
  iAmCaller = false;
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  stopLostTone?.();
  stopLostTone = null;
  socket.setFastReconnect(false);
}

/** Пересобрать маршрут звука (ICE restart). Делает только звонивший. */
async function restartIce(force = false) {
  const callId = useCallStore.getState().callId;
  if (!iAmCaller || !peer || !callId || !socket.isOpen()) return;
  const state = peer.connectionState();
  if (state === null || state === "connected" || state === "closed") return;
  if (!force && Date.now() - lastRestartAt < RESTART_THROTTLE_MS) return;
  lastRestartAt = Date.now();
  try {
    const sdp = await peer.restartIce();
    if (sdp) socket.send({ type: "call_offer", call_id: callId, sdp });
  } catch {
    // следующая попытка — по таймеру или при возврате собеседника
  }
}

/** Пока идёт звонок, проверяем связь с сервером: «зависший» сокет иначе не заметить. */
function startHeartbeat() {
  if (heartbeatTimer) return;
  socket.setFastReconnect(true);
  lastPong = Date.now();
  heartbeatTimer = setInterval(() => {
    if (socket.isOpen()) socket.send({ type: "ping" });
    if (!selfOffline && Date.now() - lastPong > PONG_TIMEOUT_MS) {
      selfOffline = true;
      updateReconnecting();
      socket.reconnectNow();
    }
    if (mediaLost) void restartIce();
  }, HEARTBEAT_MS);
}

function resolvePeerMeta(chatId: string, peerUserId: string) {
  const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
  const user = chat?.members.find((m) => m.user.id === peerUserId)?.user;
  return {
    peerUsername: displayName(user) ?? "Собеседник",
    peerAvatarUrl: user?.avatar_url ?? null,
  };
}

function cleanupPeer() {
  peer?.close();
  peer = null;
  cameraBeforeScreen = false;
}

/** Сказать собеседнику, что я теперь показываю. */
function sendMedia(localVideo: LocalVideo) {
  const callId = useCallStore.getState().callId;
  if (!callId) return;
  socket.send({ type: "call_media", call_id: callId, video: localVideo === "camera", screen: localVideo === "screen" });
}

function exitPictureInPicture() {
  if (typeof document !== "undefined" && document.pictureInPictureElement) {
    void document.exitPictureInPicture().catch(() => {});
  }
}

function stopRing() {
  stopRingtone?.();
  stopRingtone = null;
}

function startRing() {
  stopRing();
  stopRingtone = startCallRingtone();
}

function scheduleClear() {
  if (endClearTimer) clearTimeout(endClearTimer);
  endClearTimer = setTimeout(() => {
    useCallStore.getState().clearEnded();
  }, 2500);
}

async function ensurePeer(media: CallMedia): Promise<CallPeer> {
  if (peer) return peer;
  const iceServers = await callsApi.iceServers();
  peer = new CallPeer(iceServers, media, {
    onIceCandidate: (candidate) => {
      const callId = useCallStore.getState().callId;
      if (!callId) return;
      socket.send({ type: "call_ice", call_id: callId, candidate });
    },
    onRemoteStream: (stream) => {
      useCallStore.setState({ remoteStream: stream });
    },
    onConnectionState: (state) => {
      const phase = useCallStore.getState().phase;
      if (state === "connected") {
        mediaLost = false;
        if (phase === "connecting" || phase === "active") {
          useCallStore.setState({ phase: "active", error: null });
        }
        updateReconnecting();
      } else if ((state === "disconnected" || state === "failed") && phase === "active") {
        // Разговор уже шёл — ждём возвращения связи, а не кладём трубку.
        mediaLost = true;
        updateReconnecting();
        void restartIce();
      } else if (state === "failed") {
        useCallStore.getState().hangup();
        useCallStore.setState({
          phase: "ended",
          endReason: "failed",
          error: "Не удалось установить соединение",
        });
        scheduleClear();
      }
    },
    onError: (message) => {
      useCallStore.setState({ error: message });
    },
    onNoiseSuppression: (active) => {
      useCallStore.setState({ noiseSuppressionActive: active });
    },
  }, useCallStore.getState().noiseSuppression);
  startHeartbeat();
  return peer;
}

function finishCall(reason: EndReason, error: string | null = null) {
  const callId = useCallStore.getState().callId;
  stopRing();
  void clearCallNotification(callId);
  cleanupPeer();
  resetReconnect();
  useCallStore.setState({
    phase: "ended",
    endReason: reason,
    error,
    reconnecting: null,
    reconnectDeadline: null,
    remoteStream: null,
    localStream: null,
    muted: false,
    noiseSuppressionActive: false,
    ...initialVideo({ audio: true, video: false }),
  });
  exitPictureInPicture();
  scheduleClear();
  void useCallStore.getState().loadHistory();
}

async function beginOutgoingCall(
  set: (partial: Partial<CallState> | ((s: CallState) => Partial<CallState>)) => void,
  get: () => CallState,
  chatId: string,
  peerUserId: string,
  media: CallMedia
) {
  const phase = get().phase;
  if (phase !== "idle" && phase !== "ended") return;
  // Личный звонок и Планета одновременно — нельзя: микрофон один.
  await useVoiceStore.getState().leave();
  applyIosRoute();

  const callId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const meta = resolvePeerMeta(chatId, peerUserId);
  iAmCaller = true;

  set({
    phase: "outgoing",
    callId,
    chatId,
    peerUserId,
    media,
    muted: false,
    noiseSuppressionActive: false,
    ...initialVideo(media),
    error: null,
    endReason: null,
    remoteStream: null,
    localStream: null,
    ...meta,
  });

  try {
    const p = await ensurePeer(media);
    const local = await p.startLocalMedia();
    set({ localStream: local });
  } catch (err) {
    cleanupPeer();
    finishCall(
      "error",
      err instanceof Error
        ? err.message
        : media.video
          ? "Нет доступа к камере или микрофону"
          : "Нет доступа к микрофону"
    );
    return;
  }

  socket.send({
    type: "call_invite",
    call_id: callId,
    chat_id: chatId,
    callee_id: peerUserId,
    media,
    device_id: deviceId,
  });
}

/** Звонок принят на другом устройстве этого же аккаунта — молча закрываем входящий. */
function answeredElsewhere() {
  finishCall("hangup");
  useCallStore.getState().clearEnded();
}

export const useCallStore = create<CallState>((set, get) => {
  socket.onStatus((open) => {
    const callId = get().callId;
    if (!callId || !inCall()) return;
    if (open) {
      lastPong = Date.now();
      selfOffline = false;
      socket.send({ type: "call_resume", call_id: callId, device_id: deviceId });
      updateReconnecting();
      void restartIce(true);
    } else {
      selfOffline = true;
      updateReconnecting();
    }
  });

  if (typeof window !== "undefined") {
    window.addEventListener("offline", () => {
      if (!inCall()) return;
      selfOffline = true;
      updateReconnecting();
    });
  }

  socket.on((event: WsEvent) => {
    void (async () => {
      const myId = useAuthStore.getState().user?.id;
      if (!myId) return;

      switch (event.type) {
        case "call_invite": {
          if (event.callee_id !== myId) return;
          if (get().phase !== "idle" && get().phase !== "ended" && get().phase !== "incoming") {
            if (get().callId !== event.call_id) {
              socket.send({ type: "call_reject", call_id: event.call_id, reason: "busy" });
            }
            return;
          }
          const meta = resolvePeerMeta(event.chat_id, event.caller_id);
          set({
            phase: "incoming",
            callId: event.call_id,
            chatId: event.chat_id,
            peerUserId: event.caller_id,
            media: event.media ?? { audio: true, video: false },
            ...initialVideo(event.media ?? { audio: true, video: false }),
            error: null,
            endReason: null,
            ...meta,
          });
          startRing();
          void notifyIncomingCall({
            callId: event.call_id,
            chatId: event.chat_id,
            callerId: event.caller_id,
            callerName: meta.peerUsername,
            video: event.media?.video === true,
          });
          break;
        }

        case "call_ringing": {
          if (get().callId && get().callId !== event.call_id) return;
          set({
            phase: "outgoing",
            callId: event.call_id,
            chatId: event.chat_id,
            peerUserId: event.callee_id,
            media: event.media ?? get().media,
          });
          break;
        }

        case "call_accept": {
          if (event.call_id !== get().callId) return;
          if (event.accepted_by === myId && get().phase === "incoming") {
            answeredElsewhere();
            return;
          }
          stopRing();
          void clearCallNotification(event.call_id);
          set({ phase: "connecting" });
          if (event.accepted_by !== myId) {
            try {
              const p = await ensurePeer(get().media);
              const local = await p.startLocalMedia();
              set({ localStream: local });
              const sdp = await p.createOffer();
              socket.send({ type: "call_offer", call_id: event.call_id, sdp });
            } catch (err) {
              finishCall(
                "error",
                err instanceof Error ? err.message : "Нет доступа к микрофону"
              );
            }
          }
          break;
        }

        case "call_offer": {
          if (event.call_id !== get().callId) return;
          // Звонок принят на другом устройстве — этому отвечать нельзя.
          if (get().phase === "incoming") return;
          // Во время разговора offer — это пересборка маршрута после обрыва связи.
          const renegotiation = get().phase === "active";
          try {
            if (!renegotiation) set({ phase: "connecting" });
            const p = await ensurePeer(get().media);
            if (!get().localStream) {
              const local = await p.startLocalMedia();
              set({ localStream: local });
            }
            const answer = await p.handleRemoteOffer(event.sdp);
            socket.send({ type: "call_answer", call_id: event.call_id, sdp: answer });
          } catch (err) {
            if (renegotiation) break; // звонивший попробует ещё раз
            finishCall(
              "error",
              err instanceof Error ? err.message : "Ошибка установки звонка"
            );
          }
          break;
        }

        case "call_answer": {
          if (event.call_id !== get().callId) return;
          try {
            const p = await ensurePeer(get().media);
            await p.handleRemoteAnswer(event.sdp);
          } catch (err) {
            if (get().phase === "active") break; // ответ на устаревший offer после обрыва
            finishCall(
              "error",
              err instanceof Error ? err.message : "Ошибка ответа SDP"
            );
          }
          break;
        }

        case "call_ice": {
          if (event.call_id !== get().callId) return;
          await peer?.addIceCandidate(event.candidate);
          break;
        }

        case "call_reject": {
          if (event.call_id !== get().callId) return;
          finishCall("reject", "Звонок отклонён");
          break;
        }

        case "call_hangup": {
          if (event.call_id !== get().callId) return;
          if (event.reason === "answered_elsewhere") {
            answeredElsewhere();
          } else if (event.reason === "timeout") {
            finishCall("timeout", "Нет ответа");
          } else if (event.reason === "disconnect") {
            finishCall(
              "disconnect",
              event.ended_by === myId ? "Связь прервалась" : "Связь с собеседником прервалась"
            );
          } else {
            finishCall("hangup");
          }
          break;
        }

        case "call_reconnecting": {
          if (event.call_id !== get().callId || event.user_id === myId) return;
          peerLost = true;
          updateReconnecting();
          break;
        }

        case "call_reconnected": {
          if (event.call_id !== get().callId || event.user_id === myId) return;
          peerLost = false;
          updateReconnecting();
          void restartIce(true);
          break;
        }

        case "call_resume_failed": {
          if (event.call_id !== get().callId) return;
          // Сервер звонка уже не знает; если и звук не идёт — продолжать нечего.
          if (peer?.connectionState() !== "connected") finishCall("disconnect", "Связь прервалась");
          break;
        }

        case "pong": {
          lastPong = Date.now();
          if (selfOffline && socket.isOpen()) {
            selfOffline = false;
            updateReconnecting();
          }
          break;
        }

        case "call_busy": {
          finishCall("busy", "Абонент занят");
          break;
        }

        case "call_unavailable": {
          finishCall("unavailable", "Абонент недоступен (офлайн)");
          break;
        }

        case "call_media": {
          if (event.call_id !== get().callId) return;
          set({ remoteVideo: { video: event.video, screen: event.screen } });
          break;
        }

        case "call_error": {
          if (event.call_id && get().callId && event.call_id !== get().callId) return;
          finishCall("error", event.error || "Ошибка звонка");
          break;
        }

        default:
          break;
      }
    })();
  });

  return {
    phase: "idle",
    callId: null,
    chatId: null,
    peerUserId: null,
    peerUsername: null,
    peerAvatarUrl: null,
    media: { audio: true, video: false },
    muted: false,
    noiseSuppression: getNoiseSuppressionPref(),
    noiseSuppressionActive: false,
    ...initialVideo({ audio: true, video: false }),
    remoteStream: null,
    localStream: null,
    error: null,
    endReason: null,
    reconnecting: null,
    reconnectDeadline: null,
    history: [],

    prepareIncomingFromPush: (info) => {
      const phase = get().phase;
      if (phase !== "idle" && phase !== "ended" && get().callId !== info.callId) return;
      const peerUserId = info.callerId ?? get().peerUserId;
      const meta =
        info.chatId && peerUserId
          ? resolvePeerMeta(info.chatId, peerUserId)
          : {
              peerUsername: info.callerName ?? get().peerUsername ?? "Собеседник",
              peerAvatarUrl: get().peerAvatarUrl,
            };
      if (info.callerName) meta.peerUsername = info.callerName;
      set({
        phase: "incoming",
        callId: info.callId,
        chatId: info.chatId,
        peerUserId: peerUserId,
        media: info.media ?? { audio: true, video: false },
        ...initialVideo(info.media ?? { audio: true, video: false }),
        error: null,
        endReason: null,
        ...meta,
      });
      startRing();
    },

    startAudioCall: async (chatId, peerUserId) => {
      await beginOutgoingCall(set, get, chatId, peerUserId, { audio: true, video: false });
    },

    startVideoCall: async (chatId, peerUserId) => {
      await beginOutgoingCall(set, get, chatId, peerUserId, { audio: true, video: true });
    },

    accept: async () => {
      const { callId, phase, media } = get();
      if (!callId || phase !== "incoming") return;
      stopRing();
      void clearCallNotification(callId);
      await useVoiceStore.getState().leave();
      applyIosRoute();
      set({ phase: "connecting", error: null });
      try {
        const p = await ensurePeer(media);
        const local = await p.startLocalMedia();
        set({ localStream: local });
        socket.send({ type: "call_accept", call_id: callId, device_id: deviceId });
      } catch (err) {
        socket.send({ type: "call_reject", call_id: callId, reason: "media_error" });
        const needCam = media.video;
        finishCall(
          "error",
          err instanceof Error
            ? err.message
            : needCam
              ? "Нет доступа к камере или микрофону"
              : "Нет доступа к микрофону"
        );
      }
    },

    reject: () => {
      const { callId } = get();
      if (callId) {
        socket.send({ type: "call_reject", call_id: callId, reason: "rejected" });
      }
      finishCall("reject");
    },

    hangup: () => {
      const { callId, phase } = get();
      if (!callId || phase === "idle" || phase === "ended") {
        cleanupPeer();
        stopRing();
        return;
      }
      socket.send({ type: "call_hangup", call_id: callId, reason: "hangup" });
      finishCall("hangup");
    },

    switchMicrophone: async () => {
      try {
        await peer?.switchMicrophone();
      } catch {
        set({ error: "Не удалось переключить микрофон" });
      }
    },

    toggleNoiseSuppression: async () => {
      const next = !get().noiseSuppression;
      setNoiseSuppressionPref(next);
      set({ noiseSuppression: next });
      if (!peer) return;
      const active = await peer.setNoiseSuppression(next);
      set({ noiseSuppressionActive: active });
    },

    toggleMute: () => {
      const next = !get().muted;
      peer?.setMuted(next);
      set({ muted: next });
    },

    canSendVideo: () => !!peer?.canSendVideo(),

    toggleCamera: async () => {
      if (!peer) return;
      const turnOn = get().localVideo !== "camera";
      try {
        if (turnOn) await peer.startCamera();
        else await peer.setOutgoingVideo(null);
      } catch {
        set({ error: turnOn ? "Не удалось включить камеру" : "Не удалось выключить камеру" });
        return;
      }
      const localVideo: LocalVideo = turnOn ? "camera" : null;
      cameraBeforeScreen = false;
      set({ localVideo, cameraOff: !turnOn, localStream: peer.getLocalStream(), error: null });
      sendMedia(localVideo);
    },

    toggleScreenShare: async () => {
      if (!peer) return;
      const p = peer;
      if (get().localVideo === "screen") {
        // Показ закончили кнопкой в звонке — возвращаем камеру, если она была.
        try {
          if (cameraBeforeScreen) await p.startCamera();
          else await p.setOutgoingVideo(null);
        } catch {
          await p.setOutgoingVideo(null).catch(() => {});
          cameraBeforeScreen = false;
        }
        const localVideo: LocalVideo = cameraBeforeScreen ? "camera" : null;
        cameraBeforeScreen = false;
        set({ localVideo, cameraOff: localVideo !== "camera", localStream: p.getLocalStream() });
        sendMedia(localVideo);
        return;
      }
      cameraBeforeScreen = get().localVideo === "camera";
      let track: MediaStreamTrack;
      try {
        track = await p.startScreen();
      } catch (err) {
        cameraBeforeScreen = false;
        // Человек сам закрыл окно выбора экрана — это не ошибка.
        if (err instanceof DOMException && err.name === "NotAllowedError") return;
        set({ error: "Не удалось показать экран" });
        return;
      }
      // «Закрыть доступ» в панели браузера — показ закончился сам.
      track.addEventListener("ended", () => {
        if (peer === p && get().localVideo === "screen") void get().toggleScreenShare();
      });
      set({ localVideo: "screen", cameraOff: true, localStream: p.getLocalStream(), error: null });
      sendMedia("screen");
    },

    flipCamera: async () => {
      if (get().localVideo !== "camera") return;
      try {
        const stream = await peer?.flipCamera();
        if (stream) set({ localStream: stream });
      } catch {
        set({ error: "Не удалось переключить камеру" });
      }
    },

    loadHistory: async () => {
      try {
        const history = await callsApi.history();
        set({ history });
      } catch {
        // ignore
      }
    },

    clearEnded: () => {
      if (get().phase !== "ended") return;
      cleanupPeer();
      stopRing();
      set({
        phase: "idle",
        callId: null,
        chatId: null,
        peerUserId: null,
        peerUsername: null,
        peerAvatarUrl: null,
        remoteStream: null,
        localStream: null,
        error: null,
        endReason: null,
        muted: false,
        noiseSuppressionActive: false,
        ...initialVideo({ audio: true, video: false }),
        media: { audio: true, video: false },
      });
    },
  };
});

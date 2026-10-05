import { create } from "zustand";
import { callsApi } from "../api/calls";
import type { CallHistoryItem, CallMedia, CallPhase, WsEvent } from "../api/types";
import { CallPeer } from "../calls/peer";
import { socket } from "../ws/socket";
import { useAuthStore } from "./auth";
import { useChatStore } from "./chat";

type EndReason =
  | "hangup"
  | "reject"
  | "busy"
  | "unavailable"
  | "error"
  | "failed"
  | "disconnect"
  | null;

interface CallState {
  phase: CallPhase;
  callId: string | null;
  chatId: string | null;
  peerUserId: string | null;
  peerUsername: string | null;
  peerAvatarUrl: string | null;
  media: CallMedia;
  muted: boolean;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  error: string | null;
  endReason: EndReason;
  history: CallHistoryItem[];

  startAudioCall: (chatId: string, peerUserId: string) => Promise<void>;
  accept: () => Promise<void>;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  loadHistory: () => Promise<void>;
  clearEnded: () => void;
}

let peer: CallPeer | null = null;
let endClearTimer: ReturnType<typeof setTimeout> | null = null;

function resolvePeerMeta(chatId: string, peerUserId: string) {
  const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
  const user = chat?.members.find((m) => m.user.id === peerUserId)?.user;
  return {
    peerUsername: user?.username ?? "Собеседник",
    peerAvatarUrl: user?.avatar_url ?? null,
  };
}

function cleanupPeer() {
  peer?.close();
  peer = null;
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
      if (state === "connected") {
        useCallStore.setState({ phase: "active", error: null });
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
  });
  return peer;
}

function finishCall(reason: EndReason, error: string | null = null) {
  cleanupPeer();
  useCallStore.setState({
    phase: "ended",
    endReason: reason,
    error,
    remoteStream: null,
    localStream: null,
    muted: false,
  });
  scheduleClear();
  void useCallStore.getState().loadHistory();
}

export const useCallStore = create<CallState>((set, get) => {
  socket.on((event: WsEvent) => {
    void (async () => {
      const myId = useAuthStore.getState().user?.id;
      if (!myId) return;

      switch (event.type) {
        case "call_invite": {
          if (event.callee_id !== myId) return;
          if (get().phase !== "idle" && get().phase !== "ended") {
            socket.send({ type: "call_reject", call_id: event.call_id, reason: "busy" });
            return;
          }
          const meta = resolvePeerMeta(event.chat_id, event.caller_id);
          set({
            phase: "incoming",
            callId: event.call_id,
            chatId: event.chat_id,
            peerUserId: event.caller_id,
            media: event.media ?? { audio: true, video: false },
            error: null,
            endReason: null,
            ...meta,
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
          set({ phase: "connecting" });
          // Caller creates the offer after accept
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
          try {
            set({ phase: "connecting" });
            const p = await ensurePeer(get().media);
            if (!get().localStream) {
              const local = await p.startLocalMedia();
              set({ localStream: local });
            }
            const answer = await p.handleRemoteOffer(event.sdp);
            socket.send({ type: "call_answer", call_id: event.call_id, sdp: answer });
          } catch (err) {
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
          finishCall(event.reason === "disconnect" ? "disconnect" : "hangup");
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
    remoteStream: null,
    localStream: null,
    error: null,
    endReason: null,
    history: [],

    startAudioCall: async (chatId, peerUserId) => {
      const phase = get().phase;
      if (phase !== "idle" && phase !== "ended") return;

      const callId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const meta = resolvePeerMeta(chatId, peerUserId);
      const media: CallMedia = { audio: true, video: false };

      set({
        phase: "outgoing",
        callId,
        chatId,
        peerUserId,
        media,
        muted: false,
        error: null,
        endReason: null,
        remoteStream: null,
        localStream: null,
        ...meta,
      });

      try {
        // Warm mic early so accept→offer is faster; ignore if user denies until accept path.
        const p = await ensurePeer(media);
        const local = await p.startLocalMedia();
        set({ localStream: local });
      } catch {
        // Permission can be requested again on accept/offer; still allow ringing.
        cleanupPeer();
      }

      socket.send({
        type: "call_invite",
        call_id: callId,
        chat_id: chatId,
        callee_id: peerUserId,
        media,
      });
    },

    accept: async () => {
      const { callId, phase, media } = get();
      if (!callId || phase !== "incoming") return;
      set({ phase: "connecting", error: null });
      try {
        const p = await ensurePeer(media);
        const local = await p.startLocalMedia();
        set({ localStream: local });
        socket.send({ type: "call_accept", call_id: callId });
      } catch (err) {
        socket.send({ type: "call_reject", call_id: callId, reason: "media_error" });
        finishCall(
          "error",
          err instanceof Error ? err.message : "Нет доступа к микрофону"
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
        return;
      }
      socket.send({ type: "call_hangup", call_id: callId, reason: "hangup" });
      finishCall("hangup");
    },

    toggleMute: () => {
      const next = !get().muted;
      peer?.setMuted(next);
      set({ muted: next });
    },

    loadHistory: async () => {
      try {
        const history = await callsApi.history();
        set({ history });
      } catch {
        // ignore — history is non-critical for MVP
      }
    },

    clearEnded: () => {
      if (get().phase !== "ended") return;
      cleanupPeer();
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
        media: { audio: true, video: false },
      });
    },
  };
});

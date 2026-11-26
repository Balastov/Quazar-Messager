/**
 * Оверлей поверх окон (десктоп): кто в комнате или в личном звонке и кто говорит, идёт ли запись —
 * когда окно Quazar не впереди. Окно рисует десктоп-приложение; отсюда уходит только снимок
 * и настройки оверлея. Ctrl+Shift+M и Ctrl+Shift+D десктоп ловит и в других программах.
 */
import { create } from "zustand";
import type { StarDetail } from "../api/stars";
import { presenceName } from "../components/constellation/rules";
import { useAuthStore } from "../store/auth";
import { useCallStore } from "../store/call";
import { useStarsStore } from "../store/stars";
import { useVoiceStore, type VoicePeer } from "../store/voice";
import { displayName } from "../utils/profile";
import { SpeakingMonitor } from "../voice/speaking";
import type { DesktopBridge } from "./desktop";

export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface OverlayPrefs {
  /** Показывать оверлей поверх других окон. */
  enabled: boolean;
  /** Клавиши микрофона и звука работают и в других программах. */
  globalKeys: boolean;
  corner: OverlayCorner;
}

export interface OverlayPeer {
  name: string;
  speaking: boolean;
  micOn: boolean;
  isLocal: boolean;
  deafened: boolean;
}

export interface OverlayRecording {
  /** Кто записывает («вы» — я сам). */
  by: string;
  /** С какого времени (ISO) — оверлей сам считает, сколько идёт запись. */
  since: string | null;
}

export interface OverlayState extends OverlayPrefs {
  /** Название комнаты или «Звонок: Имя». */
  room: string;
  reconnecting: boolean;
  peers: OverlayPeer[];
  /** Сколько участников не поместилось. */
  more: number;
  recording: OverlayRecording | null;
}

export const OVERLAY_MAX_PEERS = 12;
const KEY = "quazar_overlay";
const DEFAULTS: OverlayPrefs = { enabled: true, globalKeys: true, corner: "top-left" };
const CORNERS: OverlayCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

function loadPrefs(): OverlayPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<OverlayPrefs>;
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
      globalKeys: typeof saved.globalKeys === "boolean" ? saved.globalKeys : DEFAULTS.globalKeys,
      corner: CORNERS.includes(saved.corner as OverlayCorner) ? (saved.corner as OverlayCorner) : DEFAULTS.corner,
    };
  } catch {
    return DEFAULTS;
  }
}

interface OverlayPrefsStore extends OverlayPrefs {
  setPrefs(patch: Partial<OverlayPrefs>): void;
}

/** Настройки оверлея — на этом устройстве. */
export const useOverlayPrefs = create<OverlayPrefsStore>((set, get) => ({
  ...loadPrefs(),
  setPrefs(patch) {
    set(patch);
    const { enabled, globalKeys, corner } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled, globalKeys, corner }));
    } catch {
      // Хранилище недоступно — настройка продержится до перезапуска.
    }
  },
}));

/** Есть ли оверлей в этой сборке десктопа (у старых версий его нет). */
export function overlaySupported(bridge: DesktopBridge | undefined): boolean {
  return typeof bridge?.setOverlay === "function";
}

/**
 * Не больше OVERLAY_MAX_PEERS строк: я и те, кто сейчас говорит, видны всегда, остальные — по порядку.
 * Порядок строк не меняется, чтобы список не прыгал.
 */
function pickPeers(peers: VoicePeer[]): VoicePeer[] {
  if (peers.length <= OVERLAY_MAX_PEERS) return peers;
  const keep = new Set(peers.filter((p) => p.isLocal || p.speaking).slice(0, OVERLAY_MAX_PEERS));
  for (const p of peers) {
    if (keep.size >= OVERLAY_MAX_PEERS) break;
    keep.add(p);
  }
  return peers.filter((p) => keep.has(p));
}

/** Снимок комнаты для оверлея; null — я не в комнате. */
export function overlaySnapshot(
  voice: { status: string; channelId: string | null; peers: VoicePeer[]; deafened: boolean },
  detail: StarDetail | undefined,
  prefs: OverlayPrefs,
  myId?: string
): OverlayState | null {
  if ((voice.status !== "connected" && voice.status !== "reconnecting") || !voice.channelId) return null;
  const shown = pickPeers(voice.peers);
  const recorder = detail?.voice?.[voice.channelId]?.find((p) => p.recording);
  return {
    enabled: prefs.enabled,
    globalKeys: prefs.globalKeys,
    corner: prefs.corner,
    room: detail?.channels.find((c) => c.id === voice.channelId)?.name ?? "",
    reconnecting: voice.status === "reconnecting",
    peers: shown.map((p) => ({
      name: p.name,
      speaking: p.speaking && p.micOn,
      micOn: p.micOn,
      isLocal: p.isLocal,
      deafened: p.isLocal && voice.deafened,
    })),
    more: voice.peers.length - shown.length,
    recording: recorder && detail
      ? { by: recorder.user_id === myId ? "вы" : presenceName(detail, recorder), since: recorder.recording_since ?? null }
      : null,
  };
}

/** Личный звонок: я и собеседник. Входящий, который ещё звонит, — не разговор, его не показываем. */
export function callOverlaySnapshot(
  call: { phase: string; peerUsername: string | null; muted: boolean; reconnecting: string | null },
  myName: string,
  speaking: ReadonlySet<string>,
  prefs: OverlayPrefs
): OverlayState | null {
  if (!["outgoing", "connecting", "active"].includes(call.phase)) return null;
  const peer = call.peerUsername || "Собеседник";
  return {
    enabled: prefs.enabled,
    globalKeys: prefs.globalKeys,
    corner: prefs.corner,
    room: `${call.phase === "active" ? "Звонок" : "Вызов"}: ${peer}`,
    reconnecting: call.phase === "active" && !!call.reconnecting,
    peers: [
      { name: myName, speaking: !call.muted && speaking.has(ME), micOn: !call.muted, isLocal: true, deafened: false },
      // Выключил ли собеседник микрофон, звонок не сообщает — значок не рисуем.
      { name: peer, speaking: speaking.has(PEER), micOn: true, isLocal: false, deafened: false },
    ],
    more: 0,
    recording: null,
  };
}

const ME = "me";
const PEER = "peer";

/** Клавиша пришла из другой программы: то же, что Ctrl+Shift+M / Ctrl+Shift+D в окне Quazar. */
export function overlayHotkey(action: unknown): void {
  const call = useCallStore.getState();
  if (call.phase === "active") {
    // В личном звонке «выключить звук собеседника» нет — только микрофон.
    if (action === "mic") call.toggleMute();
    return;
  }
  const voice = useVoiceStore.getState();
  if (voice.status !== "connected") return;
  if (action === "deafen") void voice.toggleDeafen();
  else if (action === "mic" && !voice.keys.ptt) void voice.toggleMic();
}

export function startOverlay(bridge: DesktopBridge): void {
  if (!overlaySupported(bridge)) return;
  let last = "";
  // Кто говорит в личном звонке — меряем сами, только пока идёт разговор.
  let speaking: ReadonlySet<string> = new Set();
  let monitor: SpeakingMonitor | null = null;
  const callTracks = () => {
    const call = useCallStore.getState();
    const tracks = new Map<string, MediaStreamTrack>();
    const mine = call.localStream?.getAudioTracks()[0];
    const theirs = call.remoteStream?.getAudioTracks()[0];
    if (mine) tracks.set(ME, mine);
    if (theirs) tracks.set(PEER, theirs);
    return tracks;
  };
  const push = () => {
    const prefs = useOverlayPrefs.getState();
    const call = useCallStore.getState();
    const talking = call.phase === "active" && prefs.enabled;
    if (talking && !monitor) {
      monitor = new SpeakingMonitor(callTracks, (next) => { speaking = next; push(); });
      monitor.start();
    } else if (!talking && monitor) {
      monitor.stop();
      monitor = null;
      speaking = new Set();
    }
    const me = useAuthStore.getState().user;
    const voice = useVoiceStore.getState();
    const detail = voice.starId ? useStarsStore.getState().details[voice.starId] : undefined;
    const state = callOverlaySnapshot(call, displayName(me) ?? "Я", speaking, prefs) ?? overlaySnapshot(voice, detail, prefs, me?.id);
    const payload = JSON.stringify(state);
    if (payload === last) return;
    last = payload;
    bridge.setOverlay!(state);
  };
  push();
  useVoiceStore.subscribe(push);
  useStarsStore.subscribe(push);
  useCallStore.subscribe(push);
  useOverlayPrefs.subscribe(push);
  bridge.onHotkey?.(overlayHotkey);
}

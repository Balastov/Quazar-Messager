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
  /** Только те, кто сейчас говорит (и я, если у меня выключен микрофон или звук). */
  onlySpeaking: boolean;
  /** Размер: 0.75, 1, 1.25 или 1.5. */
  scale: number;
  /** Непрозрачность фона панели, %. Текст всегда непрозрачный. */
  opacity: number;
  /** Монитор (id от десктопа); null — основной. */
  display: number | null;
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
export const OVERLAY_SCALES = [0.75, 1, 1.25, 1.5];
/** Сколько строка говорившего ещё видна в режиме «только говорящие». */
export const SPEAKING_LINGER_MS = 2000;
const DEFAULTS: OverlayPrefs = { enabled: true, globalKeys: true, corner: "top-left", onlySpeaking: false, scale: 1, opacity: 78, display: null };
const CORNERS: OverlayCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const PREF_KEYS = Object.keys(DEFAULTS) as (keyof OverlayPrefs)[];

function loadPrefs(): OverlayPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<OverlayPrefs>;
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
      globalKeys: typeof saved.globalKeys === "boolean" ? saved.globalKeys : DEFAULTS.globalKeys,
      corner: CORNERS.includes(saved.corner as OverlayCorner) ? (saved.corner as OverlayCorner) : DEFAULTS.corner,
      onlySpeaking: typeof saved.onlySpeaking === "boolean" ? saved.onlySpeaking : DEFAULTS.onlySpeaking,
      scale: OVERLAY_SCALES.includes(saved.scale as number) ? (saved.scale as number) : DEFAULTS.scale,
      opacity: Number.isInteger(saved.opacity) && saved.opacity! >= 20 && saved.opacity! <= 100 ? saved.opacity! : DEFAULTS.opacity,
      display: Number.isSafeInteger(saved.display) ? saved.display! : null,
    };
  } catch {
    return DEFAULTS;
  }
}

interface OverlayPrefsStore extends OverlayPrefs {
  /** Какие клавиши («mic», «deafen») заняты другой программой — по последней попытке десктопа. */
  keysTaken: string[];
  setPrefs(patch: Partial<OverlayPrefs>): void;
}

/** Настройки оверлея — на этом устройстве. */
export const useOverlayPrefs = create<OverlayPrefsStore>((set, get) => ({
  ...loadPrefs(),
  keysTaken: [],
  setPrefs(patch) {
    set(patch);
    const state = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(PREF_KEYS.map((k) => [k, state[k]]))));
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

/** Какие строки показывать: key — кто это (id участника), peer — что о нём покажем. */
export type PeerFilter = (key: string, peer: OverlayPeer) => boolean;

function prefsOf(prefs: OverlayPrefs): OverlayPrefs {
  return Object.fromEntries(PREF_KEYS.map((k) => [k, prefs[k]])) as unknown as OverlayPrefs;
}

/** Снимок комнаты для оверлея; null — я не в комнате. */
export function overlaySnapshot(
  voice: { status: string; channelId: string | null; peers: VoicePeer[]; deafened: boolean },
  detail: StarDetail | undefined,
  prefs: OverlayPrefs,
  myId?: string,
  filter?: PeerFilter
): OverlayState | null {
  if ((voice.status !== "connected" && voice.status !== "reconnecting") || !voice.channelId) return null;
  const row = (p: VoicePeer): OverlayPeer => ({
    name: p.name,
    speaking: p.speaking && p.micOn,
    micOn: p.micOn,
    isLocal: p.isLocal,
    deafened: p.isLocal && voice.deafened,
  });
  const candidates = filter ? voice.peers.filter((p) => filter(p.userId, row(p))) : voice.peers;
  const shown = pickPeers(candidates);
  const recorder = detail?.voice?.[voice.channelId]?.find((p) => p.recording);
  return {
    ...prefsOf(prefs),
    room: detail?.channels.find((c) => c.id === voice.channelId)?.name ?? "",
    reconnecting: voice.status === "reconnecting",
    peers: shown.map(row),
    more: candidates.length - shown.length,
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
  prefs: OverlayPrefs,
  filter?: PeerFilter
): OverlayState | null {
  if (!["outgoing", "connecting", "active"].includes(call.phase)) return null;
  const peer = call.peerUsername || "Собеседник";
  const rows: [string, OverlayPeer][] = [
    [ME, { name: myName, speaking: !call.muted && speaking.has(ME), micOn: !call.muted, isLocal: true, deafened: false }],
    // Выключил ли собеседник микрофон, звонок не сообщает — значок не рисуем.
    [PEER, { name: peer, speaking: speaking.has(PEER), micOn: true, isLocal: false, deafened: false }],
  ];
  return {
    ...prefsOf(prefs),
    room: `${call.phase === "active" ? "Звонок" : "Вызов"}: ${peer}`,
    reconnecting: call.phase === "active" && !!call.reconnecting,
    peers: rows.filter(([key, p]) => !filter || filter(key, p)).map(([, p]) => p),
    more: 0,
    recording: null,
  };
}

const ME = "me";
const PEER = "peer";

/**
 * «Только говорящие»: строка видна, пока человек говорит, и ещё SPEAKING_LINGER_MS после — чтобы
 * паузы между словами не мигали. Я виден и тогда, когда у меня выключен микрофон или звук — напоминание.
 * wakeAt(ms) — когда снова собрать снимок, чтобы погасить замолчавших.
 */
export function speakingOnly(lastSpoke: Map<string, number>, now: number, wakeAt: (ms: number) => void): PeerFilter {
  return (key, peer) => {
    if (peer.speaking) lastSpoke.set(key, now);
    const since = lastSpoke.get(key);
    const lingering = since !== undefined && now - since < SPEAKING_LINGER_MS;
    if (lingering && !peer.speaking) wakeAt(since + SPEAKING_LINGER_MS - now);
    return peer.speaking || lingering || (peer.isLocal && (!peer.micOn || peer.deafened));
  };
}

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
  const lastSpoke = new Map<string, number>();
  let wake: ReturnType<typeof setTimeout> | null = null;
  let wakeIn = Infinity;
  const wakeAt = (ms: number) => { wakeIn = Math.min(wakeIn, ms); };
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
    wakeIn = Infinity;
    if (!prefs.onlySpeaking) lastSpoke.clear();
    const filter = prefs.onlySpeaking ? speakingOnly(lastSpoke, Date.now(), wakeAt) : undefined;
    const state = callOverlaySnapshot(call, displayName(me) ?? "Я", speaking, prefs, filter)
      ?? overlaySnapshot(voice, detail, prefs, me?.id, filter);
    if (wake) clearTimeout(wake);
    wake = state && wakeIn < Infinity ? setTimeout(push, wakeIn + 20) : null;
    if (!state) lastSpoke.clear();
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
  bridge.onOverlayKeys?.((taken) => {
    const list = Array.isArray(taken) ? taken.filter((k): k is string => k === "mic" || k === "deafen") : [];
    useOverlayPrefs.setState({ keysTaken: list });
  });
}

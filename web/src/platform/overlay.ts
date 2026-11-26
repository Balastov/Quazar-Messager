/**
 * Оверлей поверх окон (десктоп): кто в комнате и кто говорит — когда окно Quazar не впереди.
 * Окно рисует десктоп-приложение; отсюда уходит только снимок комнаты и настройки оверлея.
 * Ctrl+Shift+M и Ctrl+Shift+D десктоп ловит и в других программах и присылает обратно.
 */
import { create } from "zustand";
import type { StarDetail } from "../api/stars";
import { useStarsStore } from "../store/stars";
import { useVoiceStore, type VoicePeer } from "../store/voice";
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

export interface OverlayState extends OverlayPrefs {
  room: string;
  reconnecting: boolean;
  peers: OverlayPeer[];
  /** Сколько участников не поместилось. */
  more: number;
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

/** Снимок для оверлея; null — я не в комнате. */
export function overlaySnapshot(
  voice: { status: string; channelId: string | null; peers: VoicePeer[]; deafened: boolean },
  detail: StarDetail | undefined,
  prefs: OverlayPrefs
): OverlayState | null {
  if ((voice.status !== "connected" && voice.status !== "reconnecting") || !voice.channelId) return null;
  const shown = pickPeers(voice.peers);
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
  };
}

/** Клавиша пришла из другой программы: то же, что Ctrl+Shift+M / Ctrl+Shift+D в окне Quazar. */
export function overlayHotkey(action: unknown): void {
  const voice = useVoiceStore.getState();
  if (voice.status !== "connected") return;
  if (action === "deafen") void voice.toggleDeafen();
  else if (action === "mic" && !voice.keys.ptt) void voice.toggleMic();
}

export function startOverlay(bridge: DesktopBridge): void {
  if (!overlaySupported(bridge)) return;
  let last = "";
  const push = () => {
    const voice = useVoiceStore.getState();
    const detail = voice.starId ? useStarsStore.getState().details[voice.starId] : undefined;
    const state = overlaySnapshot(voice, detail, useOverlayPrefs.getState());
    const payload = JSON.stringify(state);
    if (payload === last) return;
    last = payload;
    bridge.setOverlay!(state);
  };
  push();
  useVoiceStore.subscribe(push);
  useStarsStore.subscribe(push);
  useOverlayPrefs.subscribe(push);
  bridge.onHotkey?.(overlayHotkey);
}

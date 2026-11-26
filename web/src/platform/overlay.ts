/**
 * Оверлей поверх окон (десктоп): кто в комнате или в личном звонке и кто говорит, идёт ли запись,
 * «Орбита фокуса», а ещё всплывашки с кнопками — звонок, стук, приглашение, «Скоро встреча» —
 * когда окно Quazar не впереди. Окно рисует десктоп-приложение; отсюда уходит только снимок
 * и настройки оверлея, обратно приходят нажатые кнопки. Ctrl+Shift+M и Ctrl+Shift+D десктоп ловит
 * и в других программах.
 */
import { create } from "zustand";
import type { StarDetail } from "../api/stars";
import { presenceName } from "../components/constellation/rules";
import { useAuthStore } from "../store/auth";
import { useDoorsStore, type Invite, type MyKnock } from "../store/doors";
import { isDoNotDisturb } from "../store/presence";
import { roomDoor } from "../components/constellation/rules";
import { amResting } from "../components/constellation/work";
import { socket } from "../ws/socket";
import type { KnockEvent } from "../api/stars";
import { useCallStore, type LocalVideo, type RemoteVideo } from "../store/call";
import { useRoomActivities, type RoomCache } from "../store/roomActivities";
import { focusAt } from "../components/constellation/roomActivityMath";
import { useStarsStore } from "../store/stars";
import { useVoiceStore, type VoicePeer } from "../store/voice";
import { displayName } from "../utils/profile";
import { SpeakingMonitor } from "../voice/speaking";
import type { DesktopBridge } from "./desktop";

export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
/** custom — своё место после «Переставить». */
export type OverlayPlace = OverlayCorner | "custom";

export interface OverlayPrefs {
  /** Показывать оверлей поверх других окон. */
  enabled: boolean;
  /** Клавиши микрофона и звука работают и в других программах. */
  globalKeys: boolean;
  corner: OverlayPlace;
  /** Своё место: левый верхний угол оверлея от угла рабочей области монитора. */
  position: { x: number; y: number } | null;
  /** Звонки, стук, приглашения и «Скоро встреча» — в оверлее, с кнопками. */
  alerts: boolean;
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
  /** Показывает экран. */
  sharing: boolean;
}

/** «Орбита фокуса» комнаты для оверлея; время — по часам этого компьютера. */
export interface OverlayFocus {
  phase: "work" | "break";
  running: boolean;
  /** Когда закончится фаза (мс), если таймер идёт. */
  endsAt: number | null;
  /** Сколько секунд осталось — для паузы. */
  remaining: number;
}

export interface OverlayRecording {
  /** Кто записывает («вы» — я сам). */
  by: string;
  /** С какого времени (ISO) — оверлей сам считает, сколько идёт запись. */
  since: string | null;
}

export interface OverlayToastAction {
  id: string;
  label: string;
  tone?: "primary" | "danger" | "plain";
}

/** Всплывашка в оверлее; id — «вид:ключ» (knock:<id>, call:<id>…), по нему приходит нажатая кнопка. */
export interface OverlayToast {
  id: string;
  kind: "call" | "knock" | "invite" | "meeting" | "info";
  title: string;
  sub: string;
  actions: OverlayToastAction[];
}

/** «Скоро встреча», о которой сообщил сервер. */
export interface SoonMeeting {
  id: string;
  starId: string;
  channelId: string;
  title: string;
  room: string | null;
  startsAt: number;
}

export interface OverlayState extends OverlayPrefs {
  /** Название комнаты или «Звонок: Имя»; null — не в комнате, в оверлее только всплывашки. */
  room: string | null;
  reconnecting: boolean;
  peers: OverlayPeer[];
  /** Сколько участников не поместилось. */
  more: number;
  recording: OverlayRecording | null;
  focus: OverlayFocus | null;
  toasts: OverlayToast[];
}

export const OVERLAY_MAX_PEERS = 12;
const KEY = "quazar_overlay";
export const OVERLAY_SCALES = [0.75, 1, 1.25, 1.5];
/** Сколько строка говорившего ещё видна в режиме «только говорящие». */
export const SPEAKING_LINGER_MS = 2000;
export const OVERLAY_MAX_TOASTS = 3;
/** Сколько после начала встречи ещё висит «Скоро встреча». */
const MEETING_LINGER_MS = 5 * 60_000;
const DEFAULTS: OverlayPrefs = { enabled: true, globalKeys: true, corner: "top-left", position: null, alerts: true,
  onlySpeaking: false, scale: 1, opacity: 78, display: null };
const CORNERS: OverlayCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const PREF_KEYS = Object.keys(DEFAULTS) as (keyof OverlayPrefs)[];

function loadPrefs(): OverlayPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<OverlayPrefs>;
    const at = saved.position;
    const position = at && Number.isInteger(at.x) && Number.isInteger(at.y) ? { x: at.x, y: at.y } : null;
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
      globalKeys: typeof saved.globalKeys === "boolean" ? saved.globalKeys : DEFAULTS.globalKeys,
      corner: saved.corner === "custom" && position ? "custom"
        : CORNERS.includes(saved.corner as OverlayCorner) ? (saved.corner as OverlayCorner) : DEFAULTS.corner,
      position: saved.corner === "custom" ? position : null,
      alerts: typeof saved.alerts === "boolean" ? saved.alerts : DEFAULTS.alerts,
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
  /** Оверлей сейчас переставляют («Переставить» — «Готово»). */
  placing: boolean;
  setPrefs(patch: Partial<OverlayPrefs>): void;
}

/** Настройки оверлея — на этом устройстве. */
export const useOverlayPrefs = create<OverlayPrefsStore>((set, get) => ({
  ...loadPrefs(),
  keysTaken: [],
  placing: false,
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
    sharing: p.screenSharing,
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
    focus: null,
    toasts: [],
  };
}

/** Личный звонок: я и собеседник. Входящий, который ещё звонит, — не разговор, его не показываем. */
export function callOverlaySnapshot(
  call: { phase: string; peerUsername: string | null; muted: boolean; reconnecting: string | null;
    localVideo?: LocalVideo; remoteVideo?: RemoteVideo },
  myName: string,
  speaking: ReadonlySet<string>,
  prefs: OverlayPrefs,
  filter?: PeerFilter
): OverlayState | null {
  if (!["outgoing", "connecting", "active"].includes(call.phase)) return null;
  const peer = call.peerUsername || "Собеседник";
  const rows: [string, OverlayPeer][] = [
    [ME, { name: myName, speaking: !call.muted && speaking.has(ME), micOn: !call.muted, isLocal: true, deafened: false,
      sharing: call.localVideo === "screen" }],
    // Выключил ли собеседник микрофон, звонок не сообщает — значок не рисуем.
    [PEER, { name: peer, speaking: speaking.has(PEER), micOn: true, isLocal: false, deafened: false,
      sharing: !!call.remoteVideo?.screen }],
  ];
  return {
    ...prefsOf(prefs),
    room: `${call.phase === "active" ? "Звонок" : "Вызов"}: ${peer}`,
    reconnecting: call.phase === "active" && !!call.reconnecting,
    peers: rows.filter(([key, p]) => !filter || filter(key, p)).map(([, p]) => p),
    more: 0,
    recording: null,
    focus: null,
    toasts: [],
  };
}

/** Не в комнате и не в звонке: в оверлее только всплывашки (или пример при перестановке). */
export function emptyOverlay(prefs: OverlayPrefs): OverlayState {
  return { ...prefsOf(prefs), room: null, reconnecting: false, peers: [], more: 0, recording: null, focus: null, toasts: [] };
}

type KnockItem = KnockEvent & { receivedAt: number };

/**
 * Всплывашки по порядку важности: звонок, стук, приглашения, встречи, мой стук, ответ на него.
 * В нерабочее время Звезды и в «Не беспокоить» — только звонок и то, что я сделал сам.
 * wakeIn — когда первая из них истечёт (тогда снимок собирают заново).
 */
export function overlayToasts(src: {
  call: { phase: string; callId: string | null; peerUsername: string | null; media?: { video: boolean } };
  doors: { invites: Invite[]; knocks: Record<string, KnockItem>; myKnock: MyKnock | null; notice: string | null };
  details: Record<string, StarDetail | undefined>;
  myId?: string;
  meetings: SoonMeeting[];
  now: number;
  quiet: (starId: string) => boolean;
  dnd: boolean;
}): { toasts: OverlayToast[]; wakeIn: number | null } {
  const { call, doors, details, myId, now } = src;
  const toasts: OverlayToast[] = [];
  let wake = Infinity;
  const until = (at: number) => { wake = Math.min(wake, at - now); };
  const hushed = (starId: string) => src.dnd || src.quiet(starId);
  if (call.phase === "incoming" && call.callId) {
    toasts.push({
      id: `call:${call.callId}`, kind: "call", title: `📞 ${call.peerUsername || "Собеседник"} звонит`,
      sub: call.media?.video ? "Видеозвонок" : "Аудиозвонок",
      actions: [{ id: "accept", label: "Принять", tone: "primary" }, { id: "reject", label: "Отклонить", tone: "danger" }],
    });
  }
  for (const k of Object.values(doors.knocks)) {
    const ends = k.receivedAt + k.expires_in * 1000;
    if (k.knock.status !== "pending" || ends <= now || hushed(k.star_id)) continue;
    // Как и в окне Quazar: стук — тем, кто может впустить в эту комнату.
    const detail = details[k.star_id];
    const channel = detail?.channels.find((c) => c.id === k.knock.channel_id);
    if (detail && channel && !roomDoor(detail, channel, myId).canAnswer) continue;
    until(ends);
    toasts.push({
      id: `knock:${k.knock.id}`, kind: "knock", title: `✊ ${k.user_name} стучится`, sub: `в «${k.room_name}» · ${k.star_name}`,
      actions: [{ id: "admit", label: "Впустить", tone: "primary" }, { id: "wait", label: "В зал" }, { id: "deny", label: "Отказать", tone: "danger" }],
    });
  }
  for (const invite of doors.invites) {
    if (invite.expiresAt <= now || hushed(invite.starId)) continue;
    until(invite.expiresAt);
    toasts.push({
      id: `invite:${invite.channelId}`, kind: "invite", title: `🚪 ${invite.fromName} зовёт вас`,
      sub: `в «${invite.roomName}» · ${invite.starName}`,
      actions: [{ id: "join", label: "Войти", tone: "primary" }, { id: "dismiss", label: "Не сейчас" }],
    });
  }
  for (const meeting of src.meetings) {
    const ends = meeting.startsAt + MEETING_LINGER_MS;
    if (ends <= now || hushed(meeting.starId)) continue;
    until(ends);
    const at = new Date(meeting.startsAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    toasts.push({
      id: `meeting:${meeting.id}`, kind: "meeting", title: `⏰ Скоро встреча: ${meeting.title}`,
      sub: [meeting.room, `в ${at}`].filter(Boolean).join(" · "),
      actions: [{ id: "join", label: "Войти", tone: "primary" }, { id: "dismiss", label: "Скрыть" }],
    });
  }
  const mine = doors.myKnock;
  if (mine) {
    toasts.push(mine.status === "pending"
      ? { id: `myknock:${mine.knockId}`, kind: "knock", title: "✊ Вы постучались", sub: `в «${mine.roomName}» — ждём ответа…`,
        actions: [{ id: "cancel", label: "Отменить стук" }] }
      : { id: `myknock:${mine.knockId}`, kind: "knock", title: "🛋 Вы в зале ожидания", sub: `вас впустят в «${mine.roomName}»`,
        actions: [{ id: "cancel", label: "Больше не ждать" }] });
  }
  if (doors.notice) toasts.push({ id: `info:${doors.notice}`, kind: "info", title: doors.notice, sub: "", actions: [] });
  return { toasts: toasts.slice(0, OVERLAY_MAX_TOASTS), wakeIn: wake < Infinity ? Math.max(0, wake) : null };
}

/** Войти в комнату встречи — как кнопкой в окне Quazar: с дверью, стуком и местами. */
async function enterMeeting(starId: string, channelId: string): Promise<void> {
  const stars = useStarsStore.getState();
  if (!stars.details[starId]) await stars.selectStar(starId);
  const detail = useStarsStore.getState().details[starId];
  const channel = detail?.channels.find((c) => c.id === channelId);
  if (detail && channel) await useDoorsStore.getState().enterRoom(detail, channel);
}

/** Нажали кнопку во всплывашке оверлея. Проверяем, что такая всплывашка ещё есть. */
export async function overlayAction(value: unknown, meetings: Map<string, SoonMeeting>): Promise<void> {
  if (!value || typeof value !== "object") return;
  const { toast, action } = value as { toast?: unknown; action?: unknown };
  if (typeof toast !== "string" || typeof action !== "string") return;
  const split = toast.indexOf(":");
  const kind = toast.slice(0, split), key = toast.slice(split + 1);
  const doors = useDoorsStore.getState();
  switch (kind) {
    case "call": {
      const call = useCallStore.getState();
      if (call.phase !== "incoming" || call.callId !== key) return;
      if (action === "accept") await call.accept();
      else if (action === "reject") call.reject();
      return;
    }
    case "knock":
      if (doors.knocks[key] && (action === "admit" || action === "wait" || action === "deny")) await doors.answer(key, action);
      return;
    case "invite": {
      const invite = doors.invites.find((i) => i.channelId === key);
      if (!invite) return;
      if (action === "join") await doors.acceptInvite(invite);
      else if (action === "dismiss") doors.dismissInvite(invite);
      return;
    }
    case "meeting": {
      const meeting = meetings.get(key);
      if (!meeting) return;
      meetings.delete(key);
      if (action === "join") await enterMeeting(meeting.starId, meeting.channelId);
      return;
    }
    case "myknock":
      if (action === "cancel" && doors.myKnock?.knockId === key) await doors.cancelKnock();
      return;
  }
}

/**
 * «Орбита фокуса» комнаты: фаза и её конец по часам этого компьютера. wakeIn — через сколько мс
 * фаза сменится (тогда снимок собирают заново: после работы — перерыв, по кругу — снова работа).
 */
export function overlayFocus(room: RoomCache | undefined, now: number): { focus: OverlayFocus | null; wakeIn: number | null } {
  if (!room?.focus) return { focus: null, wakeIn: null };
  const serverNow = now + room.clockOffset;
  const focus = focusAt(room.focus, serverNow);
  if (!focus || focus.phase === "done") return { focus: null, wakeIn: null };
  const ends = focus.running && focus.ends_at ? Date.parse(focus.ends_at) - room.clockOffset : null;
  return {
    focus: { phase: focus.phase, running: focus.running, endsAt: ends, remaining: Math.max(0, Math.ceil(focus.remaining_seconds)) },
    wakeIn: ends !== null ? Math.max(0, ends - now) : null,
  };
}

const ME = "me";
const PEER = "peer";

/**
 * «Только говорящие»: строка видна, пока человек говорит, и ещё SPEAKING_LINGER_MS после — чтобы
 * паузы между словами не мигали. Я виден и тогда, когда у меня выключен микрофон или звук или я показываю
 * экран — напоминание.
 * wakeAt(ms) — когда снова собрать снимок, чтобы погасить замолчавших.
 */
export function speakingOnly(lastSpoke: Map<string, number>, now: number, wakeAt: (ms: number) => void): PeerFilter {
  return (key, peer) => {
    if (peer.speaking) lastSpoke.set(key, now);
    const since = lastSpoke.get(key);
    const lingering = since !== undefined && now - since < SPEAKING_LINGER_MS;
    if (lingering && !peer.speaking) wakeAt(since + SPEAKING_LINGER_MS - now);
    return peer.speaking || lingering || (peer.isLocal && (!peer.micOn || peer.deafened || peer.sharing));
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
  // «Скоро встреча» — из события сервера; живёт до начала встречи и ещё 5 минут.
  const meetings = new Map<string, SoonMeeting>();
  socket.on((event) => {
    if (event.type !== "star_booking_soon") return;
    const startsAt = Date.parse(event.starts_at);
    if (!Number.isFinite(startsAt)) return;
    meetings.set(event.booking_id, { id: event.booking_id, starId: event.star_id, channelId: event.channel_id,
      title: event.title, room: event.room, startsAt });
    push();
  });
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
    const roomState = overlaySnapshot(voice, detail, prefs, me?.id, filter);
    if (roomState && voice.channelId) {
      const { focus, wakeIn } = overlayFocus(useRoomActivities.getState().rooms[voice.channelId], Date.now());
      roomState.focus = focus;
      if (wakeIn !== null) wakeAt(wakeIn);
    }
    const now = Date.now();
    for (const [id, m] of meetings) if (m.startsAt + MEETING_LINGER_MS <= now) meetings.delete(id);
    const { toasts, wakeIn: toastsWake } = prefs.alerts
      ? overlayToasts({ call, doors: useDoorsStore.getState(), details: useStarsStore.getState().details, myId: me?.id,
        meetings: [...meetings.values()], now, quiet: (starId) => amResting(starId), dnd: isDoNotDisturb() })
      : { toasts: [], wakeIn: null };
    if (toastsWake !== null) wakeAt(toastsWake);
    const base = callOverlaySnapshot(call, displayName(me) ?? "Я", speaking, prefs, filter) ?? roomState;
    // Не в комнате: оверлей нужен для всплывашек или пока его переставляют.
    const state = base ? { ...base, toasts } : toasts.length || useOverlayPrefs.getState().placing ? { ...emptyOverlay(prefs), toasts } : null;
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
  useRoomActivities.subscribe(push);
  useDoorsStore.subscribe(push);
  bridge.onHotkey?.(overlayHotkey);
  bridge.onOverlayKeys?.((taken) => {
    const list = Array.isArray(taken) ? taken.filter((k): k is string => k === "mic" || k === "deafen") : [];
    useOverlayPrefs.setState({ keysTaken: list });
  });
  bridge.onOverlayAction?.((value) => void overlayAction(value, meetings).finally(push));
  // Оверлей перетащили — его место (и монитор) запоминаем как настройку.
  bridge.onOverlayMoved?.((value) => {
    const at = value as { display?: unknown; x?: unknown; y?: unknown } | null;
    if (!at || !Number.isInteger(at.x) || !Number.isInteger(at.y)) return;
    useOverlayPrefs.getState().setPrefs({ corner: "custom", position: { x: at.x as number, y: at.y as number },
      display: Number.isSafeInteger(at.display) ? (at.display as number) : null });
  });
  bridge.onOverlayPlacing?.((on) => useOverlayPrefs.setState({ placing: on === true }));
}

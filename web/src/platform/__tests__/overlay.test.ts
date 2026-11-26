import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StarDetail } from "../../api/stars";
import type { VoicePeer } from "../../store/voice";
import type { DesktopBridge } from "../desktop";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
const sockets = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock("../../ws/socket", () => ({ socket: { on: (h: (event: unknown) => void) => { sockets.handlers.push(h); return () => {}; },
  onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));

const { overlaySnapshot, callOverlaySnapshot, overlayHotkey, overlayFocus, overlayToasts, overlayAction, startOverlay, useOverlayPrefs, speakingOnly,
  OVERLAY_MAX_PEERS, SPEAKING_LINGER_MS } = await import("../overlay");
const { useDoorsStore } = await import("../../store/doors");
const { emptyRoom } = await import("../../store/roomActivities");
const { useCallStore } = await import("../../store/call");
const { useVoiceStore } = await import("../../store/voice");
const { useStarsStore } = await import("../../store/stars");
const { useRoomActivities } = await import("../../store/roomActivities");
const { VoiceKeysSettings } = await import("../../components/constellation/VoicePanels");

const PREFS = { enabled: true, globalKeys: true, corner: "top-left" as const, position: null, alerts: true, onlySpeaking: false, scale: 1, opacity: 78, display: null };
const detail = { id: "star", members: [], my_permissions: [], channels: [{ id: "room", kind: "planet", name: "Переговорная" }] } as unknown as StarDetail;
const peer = (name: string, patch: Partial<VoicePeer> = {}): VoicePeer =>
  ({ userId: name, name, isLocal: false, speaking: false, micOn: true, screenSharing: false, cameraOn: false, ...patch });

beforeEach(() => {
  memory.clear();
  delete window.quazarDesktop;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

describe("снимок комнаты для оверлея", () => {
  it("только в комнате: название, кто говорит, микрофон и звук", () => {
    const peers = [peer("Анна", { isLocal: true, speaking: true }), peer("Боб", { speaking: true, micOn: false })];
    expect(overlaySnapshot({ status: "idle", channelId: null, peers: [], deafened: false }, detail, PREFS)).toBeNull();
    expect(overlaySnapshot({ status: "connecting", channelId: "room", peers, deafened: false }, detail, PREFS)).toBeNull();
    const state = overlaySnapshot({ status: "connected", channelId: "room", peers, deafened: true }, detail, PREFS)!;
    expect(state).toMatchObject({ room: "Переговорная", reconnecting: false, more: 0, corner: "top-left" });
    expect(state.peers).toEqual([
      { name: "Анна", speaking: true, micOn: true, isLocal: true, deafened: true, sharing: false },
      // Микрофон выключен — «говорит» не показываем, даже если монитор что-то услышал.
      { name: "Боб", speaking: false, micOn: false, isLocal: false, deafened: false, sharing: false },
    ]);
    expect(overlaySnapshot({ status: "reconnecting", channelId: "room", peers, deafened: false }, detail, PREFS)?.reconnecting).toBe(true);
  });

  it("в большой комнате я и говорящие видны всегда, порядок не меняется", () => {
    const peers = [peer("Я", { isLocal: true }), ...Array.from({ length: 20 }, (_, i) => peer(`П${i + 1}`, { speaking: i === 17 }))];
    const state = overlaySnapshot({ status: "connected", channelId: "room", peers, deafened: false }, detail, PREFS)!;
    expect(state.peers).toHaveLength(OVERLAY_MAX_PEERS);
    expect(state.more).toBe(peers.length - OVERLAY_MAX_PEERS);
    const names = state.peers.map((p) => p.name);
    expect(names[0]).toBe("Я");
    expect(names[names.length - 1]).toBe("П18");
    expect(names.slice(1, -1)).toEqual(Array.from({ length: OVERLAY_MAX_PEERS - 2 }, (_, i) => `П${i + 1}`));
  });
});

describe("запись и личный звонок", () => {
  it("строка записи: кто записывает (я — «вы») и с какого времени", () => {
    const withVoice = {
      ...detail,
      members: [{ user: { id: "bob", username: "bob", display_name: "Боб" }, role: "member" }],
      voice: { room: [{ user_id: "bob", recording: true, recording_since: "2026-11-26T10:00:00Z" }] },
    } as unknown as StarDetail;
    const voice = { status: "connected", channelId: "room", peers: [peer("Анна", { isLocal: true })], deafened: false };
    expect(overlaySnapshot(voice, detail, PREFS)?.recording).toBeNull();
    expect(overlaySnapshot(voice, withVoice, PREFS, "me")?.recording).toEqual({ by: "Боб", since: "2026-11-26T10:00:00Z" });
    expect(overlaySnapshot(voice, withVoice, PREFS, "bob")?.recording).toEqual({ by: "вы", since: "2026-11-26T10:00:00Z" });
  });

  it("звонок: «Вызов», потом «Звонок» с собеседником; входящий, который ещё звонит, — нет", () => {
    const call = { phase: "outgoing", peerUsername: "Боб", muted: false, reconnecting: null };
    expect(callOverlaySnapshot({ ...call, phase: "incoming" }, "Анна", new Set(), PREFS)).toBeNull();
    expect(callOverlaySnapshot({ ...call, phase: "ended" }, "Анна", new Set(), PREFS)).toBeNull();
    expect(callOverlaySnapshot(call, "Анна", new Set(), PREFS)?.room).toBe("Вызов: Боб");
    const active = callOverlaySnapshot({ ...call, phase: "active", muted: true, reconnecting: "peer" }, "Анна", new Set(["me", "peer"]), PREFS)!;
    expect(active).toMatchObject({ room: "Звонок: Боб", reconnecting: true, more: 0, recording: null });
    expect(active.peers).toEqual([
      { name: "Анна", speaking: false, micOn: false, isLocal: true, deafened: false, sharing: false },
      { name: "Боб", speaking: true, micOn: true, isLocal: false, deafened: false, sharing: false },
    ]);
  });

  it("Ctrl+Shift+M в звонке — микрофон звонка (и в окне Quazar, и из другой программы)", () => {
    const toggleMute = vi.fn();
    const toggleDeafen = vi.fn(async () => {});
    useVoiceStore.setState({ status: "idle", toggleDeafen });
    useCallStore.setState({ phase: "active", toggleMute });
    overlayHotkey("mic");
    overlayHotkey("deafen");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, shiftKey: true }));
    expect(toggleMute).toHaveBeenCalledTimes(2);
    expect(toggleDeafen).not.toHaveBeenCalled();
    useCallStore.setState({ phase: "idle" });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, shiftKey: true }));
    expect(toggleMute).toHaveBeenCalledTimes(2);
  });
});

describe("десктоп", () => {
  it("получает снимок при каждом изменении (без повторов), клавиши из других программ переключают микрофон и звук", () => {
    const setOverlay = vi.fn();
    let hotkey: (action: string) => void = () => {};
    const bridge = { setOverlay, onHotkey: (cb: typeof hotkey) => { hotkey = cb; return () => {}; } } as unknown as DesktopBridge;
    const toggleMic = vi.fn(async () => {}), toggleDeafen = vi.fn(async () => {});
    useVoiceStore.setState({ status: "idle", channelId: null, starId: null, peers: [], toggleMic, toggleDeafen });
    startOverlay(bridge);
    expect(setOverlay).toHaveBeenLastCalledWith(null);
    act(() => {
      useStarsStore.setState({ details: { star: detail } });
      useVoiceStore.setState({ status: "connected", starId: "star", channelId: "room", peers: [peer("Анна", { isLocal: true })] });
    });
    expect(setOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ room: "Переговорная" }));
    const calls = setOverlay.mock.calls.length;
    act(() => useVoiceStore.setState({ notice: "что-то другое" }));
    expect(setOverlay.mock.calls.length).toBe(calls);
    act(() => useOverlayPrefs.getState().setPrefs({ corner: "bottom-right" }));
    expect(setOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ corner: "bottom-right" }));
    expect(JSON.parse(memory.get("quazar_overlay")!)).toEqual({ ...PREFS, corner: "bottom-right" });

    hotkey("mic");
    hotkey("deafen");
    expect(toggleMic).toHaveBeenCalledTimes(1);
    expect(toggleDeafen).toHaveBeenCalledTimes(1);
    // Рация: микрофон — только клавишей рации, как и внутри окна.
    useVoiceStore.setState({ keys: { ptt: true, pttKey: "Backquote" } });
    overlayHotkey("mic");
    expect(toggleMic).toHaveBeenCalledTimes(1);
    // Не в комнате — клавиши ничего не делают.
    useVoiceStore.setState({ status: "idle", keys: { ptt: false, pttKey: "Backquote" } });
    overlayHotkey("mic");
    expect(toggleMic).toHaveBeenCalledTimes(1);
  });

  it("настройки оверлея — только в десктопе, где он есть", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(VoiceKeysSettings)));
    expect(host.textContent).not.toContain("Оверлей");
    expect(host.textContent).toContain("пока открыта вкладка Quazar");
    act(() => root.unmount());

    window.quazarDesktop = { setOverlay: vi.fn() } as unknown as DesktopBridge;
    const root2 = createRoot(host);
    act(() => root2.render(createElement(VoiceKeysSettings)));
    expect(host.textContent).toContain("Оверлей поверх окон");
    const overlayBox = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Оверлей"))!.querySelector("input")!;
    act(() => Simulate.change(overlayBox, { target: { checked: false } } as never));
    expect(useOverlayPrefs.getState().enabled).toBe(false);
    expect(host.querySelector("select")).toBeNull();
    act(() => root2.unmount());
  });
});

describe("только говорящие, размер, монитор, занятые клавиши", () => {
  it("строка видна, пока говорят, и ещё 2 секунды; я — если выключен микрофон или звук", () => {
    const last = new Map<string, number>();
    const wakes: number[] = [];
    const voice = (peers: VoicePeer[], deafened = false) => ({ status: "connected", channelId: "room", peers, deafened });
    const prefs = { ...PREFS, onlySpeaking: true };
    const names = (peers: VoicePeer[], now: number, deafened = false) =>
      overlaySnapshot(voice(peers, deafened), detail, prefs, "me", speakingOnly(last, now, (ms) => wakes.push(ms)))!.peers.map((p) => p.name);
    const me = peer("Я", { isLocal: true });
    expect(names([me, peer("Боб"), peer("Ева")], 0)).toEqual([]);
    expect(names([me, peer("Боб", { speaking: true }), peer("Ева")], 1000)).toEqual(["Боб"]);
    // Боб замолчал — ещё виден, и снимок попросят собрать снова, когда строку пора гасить.
    expect(names([me, peer("Боб"), peer("Ева")], 2500)).toEqual(["Боб"]);
    expect(wakes[wakes.length - 1]).toBe(1000 + SPEAKING_LINGER_MS - 2500);
    expect(names([me, peer("Боб"), peer("Ева")], 1000 + SPEAKING_LINGER_MS)).toEqual([]);
    // Говорит с выключенным микрофоном — это не «говорит».
    expect(names([me, peer("Ева", { speaking: true, micOn: false })], 4000)).toEqual([]);
    expect(names([peer("Я", { isLocal: true, micOn: false }), peer("Боб")], 5000)).toEqual(["Я"]);
    expect(names([me, peer("Боб")], 5000, true)).toEqual(["Я"]);
    // Звонок — так же.
    const call = callOverlaySnapshot({ phase: "active", peerUsername: "Боб", muted: false, reconnecting: null }, "Анна", new Set(["peer"]), prefs,
      speakingOnly(new Map(), 0, () => {}))!;
    expect(call.peers.map((p) => p.name)).toEqual(["Боб"]);
  });

  it("в десктопе замолчавший гаснет сам, без новых событий", () => {
    vi.useFakeTimers();
    try {
      const setOverlay = vi.fn();
      useOverlayPrefs.setState({ ...PREFS, onlySpeaking: true });
      useStarsStore.setState({ details: { star: detail } });
      useCallStore.setState({ phase: "idle" });
      useVoiceStore.setState({ status: "connected", starId: "star", channelId: "room", peers: [peer("Я", { isLocal: true }), peer("Боб", { speaking: true })] });
      startOverlay({ setOverlay } as unknown as DesktopBridge);
      const shown = () => (setOverlay.mock.lastCall![0] as { peers: { name: string }[] }).peers.map((p) => p.name);
      expect(shown()).toEqual(["Боб"]);
      act(() => useVoiceStore.setState({ peers: [peer("Я", { isLocal: true }), peer("Боб")] }));
      expect(shown()).toEqual(["Боб"]);
      act(() => void vi.advanceTimersByTime(SPEAKING_LINGER_MS + 50));
      expect(shown()).toEqual([]);
    } finally {
      vi.useRealTimers();
      useOverlayPrefs.setState(PREFS);
      useVoiceStore.setState({ status: "idle", channelId: null, starId: null, peers: [] });
    }
  });

  it("настройки сохраняются, чужие значения из хранилища не проходят", async () => {
    memory.set("quazar_overlay", JSON.stringify({ scale: 3, opacity: 5, display: "DELL", onlySpeaking: "да", corner: "center" }));
    vi.resetModules();
    const fresh = await import("../overlay");
    expect(fresh.useOverlayPrefs.getState()).toMatchObject(PREFS);
    fresh.useOverlayPrefs.getState().setPrefs({ scale: 1.25, opacity: 40, display: 2779098405, onlySpeaking: true });
    expect(JSON.parse(memory.get("quazar_overlay")!)).toEqual({ ...PREFS, scale: 1.25, opacity: 40, display: 2779098405, onlySpeaking: true });
    vi.resetModules();
    expect((await import("../overlay")).useOverlayPrefs.getState()).toMatchObject({ scale: 1.25, opacity: 40, display: 2779098405, onlySpeaking: true });
    const state = fresh.overlaySnapshot({ status: "connected", channelId: "room", peers: [], deafened: false }, detail, fresh.useOverlayPrefs.getState());
    expect(state).toMatchObject({ scale: 1.25, opacity: 40, display: 2779098405 });
    expect(state).not.toHaveProperty("keysTaken");
  });

  it("монитор, размер, фон и предупреждение о занятой клавише", async () => {
    useOverlayPrefs.setState({ ...PREFS, keysTaken: [] });
    let keys: (taken: string[]) => void = () => {};
    const bridge = {
      setOverlay: vi.fn(),
      onOverlayKeys: (cb: typeof keys) => { keys = cb; return () => {}; },
      listDisplays: vi.fn(async () => [{ id: 1, name: "1. Встроенный — 1440×900 (основной)", primary: true }, { id: 7, name: "2. DELL — 2560×1440", primary: false }]),
    };
    window.quazarDesktop = bridge as unknown as DesktopBridge;
    startOverlay(bridge as unknown as DesktopBridge);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(VoiceKeysSettings)));
    const select = (label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect([...select("На каком мониторе").options].map((o) => o.textContent)).toEqual(["Основной монитор", "2. DELL — 2560×1440"]);
    act(() => Simulate.change(select("На каком мониторе"), { target: { value: "7" } } as never));
    act(() => Simulate.change(select("Размер оверлея"), { target: { value: "1.5" } } as never));
    act(() => Simulate.change(host.querySelector('input[type="range"]')!, { target: { value: "45" } } as never));
    expect(useOverlayPrefs.getState()).toMatchObject({ display: 7, scale: 1.5, opacity: 45 });
    expect(host.textContent).toContain("Фон: 45%");
    expect(host.textContent).not.toContain("занята другой программой");
    act(() => keys(["mic", "evil"]));
    expect(host.textContent).toContain("Ctrl+Shift+M занята другой программой");
    act(() => keys(["mic", "deafen"]));
    expect(host.textContent).toContain("Ctrl+Shift+M и Ctrl+Shift+D заняты другой программой");
    act(() => useOverlayPrefs.getState().setPrefs({ globalKeys: false }));
    expect(host.textContent).not.toContain("заняты другой программой");
    act(() => root.unmount());
    useOverlayPrefs.setState({ ...PREFS, keysTaken: [] });
  });
});

describe("показ экрана и «Орбита фокуса»", () => {
  it("значок у того, кто показывает экран; в «только говорящих» я виден, пока показываю", () => {
    const voice = { status: "connected", channelId: "room", peers: [peer("Я", { isLocal: true, screenSharing: true }), peer("Боб", { screenSharing: true })], deafened: false };
    expect(overlaySnapshot(voice, detail, PREFS)!.peers.map((p) => p.sharing)).toEqual([true, true]);
    const only = overlaySnapshot(voice, detail, { ...PREFS, onlySpeaking: true }, "me", speakingOnly(new Map(), 0, () => {}))!;
    expect(only.peers.map((p) => p.name)).toEqual(["Я"]);
    const call = { phase: "active", peerUsername: "Боб", muted: false, reconnecting: null, localVideo: null, remoteVideo: { video: false, screen: true } };
    expect(callOverlaySnapshot(call, "Анна", new Set(), PREFS)!.peers.map((p) => p.sharing)).toEqual([false, true]);
    expect(callOverlaySnapshot({ ...call, localVideo: "screen" as const }, "Анна", new Set(), PREFS)!.peers[0].sharing).toBe(true);
  });

  it("фаза и её конец по часам компьютера; после конца работы — перерыв; на паузе — остаток", () => {
    const now = Date.parse("2026-11-27T10:00:00Z");
    const room = { ...emptyRoom("star", "room"), clockOffset: 5000, focus: {
      version: 1, owner_id: "bob", phase: "work" as const, running: true, work_seconds: 1500, break_seconds: 300,
      remaining_seconds: 1500, ends_at: "2026-11-27T10:10:05Z", loop: true } };
    expect(overlayFocus(undefined, now)).toEqual({ focus: null, wakeIn: null });
    // Сервер спешит на 5 с: конец работы в 10:10:05 по серверу — это 10:10:00 по нашим часам.
    expect(overlayFocus(room, now)).toEqual({ focus: { phase: "work", running: true, endsAt: Date.parse("2026-11-27T10:10:00Z"), remaining: 1500 }, wakeIn: 600_000 });
    const later = overlayFocus(room, Date.parse("2026-11-27T10:11:00Z"));
    expect(later.focus).toMatchObject({ phase: "break", running: true });
    expect(later.wakeIn).toBe(240_000);
    const paused = { ...room, focus: { ...room.focus, running: false, ends_at: null, remaining_seconds: 431.2 } };
    expect(overlayFocus(paused, now)).toEqual({ focus: { phase: "work", running: false, endsAt: null, remaining: 432 }, wakeIn: null });
    expect(overlayFocus({ ...room, focus: { ...room.focus, phase: "done" as const, running: false } }, now).focus).toBeNull();
  });

  it("в десктоп уходит таймер комнаты, в которой я сейчас", () => {
    const setOverlay = vi.fn();
    useOverlayPrefs.setState(PREFS);
    useCallStore.setState({ phase: "idle" });
    useStarsStore.setState({ details: { star: detail } });
    useVoiceStore.setState({ status: "connected", starId: "star", channelId: "room", peers: [peer("Я", { isLocal: true })] });
    startOverlay({ setOverlay } as unknown as DesktopBridge);
    expect(setOverlay.mock.lastCall![0].focus).toBeNull();
    act(() => useRoomActivities.setState({ rooms: { room: { ...emptyRoom("star", "room"), focus: {
      version: 1, owner_id: "bob", phase: "break", running: false, work_seconds: 1500, break_seconds: 300, remaining_seconds: 120, ends_at: null } } } }));
    expect(setOverlay.mock.lastCall![0].focus).toEqual({ phase: "break", running: false, endsAt: null, remaining: 120 });
    useVoiceStore.setState({ status: "idle", channelId: null, starId: null, peers: [] });
  });
});

const NOW = Date.parse("2026-11-27T10:50:00Z");
const knockItem = (id: string, patch: Record<string, unknown> = {}) => ({
  type: "planet_knock", star_id: "star", star_name: "Офис", room_name: "Переговорная", user_name: "Боб", expires_in: 120,
  knock: { id, channel_id: "room", user_id: "bob", status: "pending" }, receivedAt: NOW - 10_000, ...patch,
}) as never;
const noDoors = { invites: [], knocks: {}, myKnock: null, notice: null };
const idle = { phase: "idle", callId: null, peerUsername: null };
const toastsOf = (patch: Partial<Parameters<typeof overlayToasts>[0]> = {}) => overlayToasts({
  call: idle, doors: noDoors, details: {}, meetings: [], now: NOW, quiet: () => false, dnd: false, ...patch });

describe("всплывашки в оверлее", () => {
  it("звонок, стук, приглашение, встреча — по важности, не больше трёх, с кнопками", () => {
    const { toasts, wakeIn } = toastsOf({
      call: { phase: "incoming", callId: "c1", peerUsername: "Анна", media: { video: true } },
      doors: { ...noDoors, knocks: { k1: knockItem("k1") },
        invites: [{ starId: "star", channelId: "room2", fromName: "Ева", roomName: "Кухня", starName: "Офис", expiresAt: NOW + 30_000 }] },
      meetings: [{ id: "b1", starId: "star", channelId: "room", title: "Планёрка", room: "Переговорная", startsAt: NOW + 600_000 }],
    });
    expect(toasts.map((t) => t.id)).toEqual(["call:c1", "knock:k1", "invite:room2"]);
    expect(toasts[0]).toMatchObject({ kind: "call", title: "📞 Анна звонит", sub: "Видеозвонок" });
    expect(toasts[1].actions.map((a) => a.label)).toEqual(["Впустить", "В зал", "Отказать"]);
    expect(toasts[2]).toMatchObject({ title: "🚪 Ева зовёт вас", sub: "в «Кухня» · Офис" });
    // Снимок соберут заново, когда истечёт первое — приглашение через 30 с.
    expect(wakeIn).toBe(30_000);
    const meeting = toastsOf({ meetings: [{ id: "b1", starId: "star", channelId: "room", title: "Планёрка", room: "Переговорная", startsAt: NOW + 600_000 }] }).toasts[0];
    expect(meeting.title).toBe("⏰ Скоро встреча: Планёрка");
    expect(meeting.sub).toMatch(/^Переговорная · в \d\d:\d\d$/);
  });

  it("истёкшее, чужие стуки и «Не беспокоить» не показываем; свой стук и ответ — показываем", () => {
    const doors = { ...noDoors, knocks: { old: knockItem("old", { receivedAt: NOW - 200_000 }), done: knockItem("done", { knock: { id: "done", channel_id: "room", user_id: "bob", status: "waiting" } }) },
      invites: [{ starId: "star", channelId: "room2", fromName: "Ева", roomName: "Кухня", starName: "Офис", expiresAt: NOW - 1 }] };
    expect(toastsOf({ doors }).toasts).toEqual([]);
    // Впускать в эту комнату я не могу — стук не мне.
    const detail = { id: "star", kind: "work", my_role: "member", my_permissions: [], members: [], voice: {}, channels: [{ id: "room", kind: "planet", name: "Переговорная", access: "invite", host_id: "zoe" }] };
    expect(toastsOf({ doors: { ...noDoors, knocks: { k1: knockItem("k1") } }, details: { star: detail as never }, myId: "me" }).toasts).toEqual([]);
    const busy = { ...noDoors, knocks: { k1: knockItem("k1") }, myKnock: { knockId: "m1", starId: "star", channelId: "room", roomName: "Кабинет", status: "pending" as const, expiresAt: NOW + 60_000 },
      notice: "Вас впустили" };
    const call = { phase: "incoming", callId: "c1", peerUsername: "Анна" };
    expect(toastsOf({ doors: busy, call, dnd: true }).toasts.map((t) => t.id)).toEqual(["call:c1", "myknock:m1", "info:Вас впустили"]);
    expect(toastsOf({ doors: busy, quiet: (id) => id === "star" }).toasts.map((t) => t.kind)).toEqual(["knock", "info"]);
    expect(toastsOf({ doors: { ...busy, myKnock: { ...busy.myKnock, status: "waiting" } } }).toasts[1]).toMatchObject({ title: "🛋 Вы в зале ожидания" });
  });

  it("кнопки делают то же, что в окне Quazar, и только для живых всплывашек", async () => {
    const answer = vi.fn(async () => {}), acceptInvite = vi.fn(async () => {}), dismissInvite = vi.fn(), cancelKnock = vi.fn(async () => {});
    const invite = { starId: "star", channelId: "room2", fromName: "Ева", roomName: "Кухня", starName: "Офис", expiresAt: NOW };
    useDoorsStore.setState({ knocks: { k1: knockItem("k1") }, invites: [invite], answer, acceptInvite, dismissInvite, cancelKnock,
      myKnock: { knockId: "m1", starId: "star", channelId: "room", roomName: "Кабинет", status: "pending", expiresAt: NOW } });
    const accept = vi.fn(async () => {}), reject = vi.fn();
    useCallStore.setState({ phase: "incoming", callId: "c1", accept, reject });
    const meetings = new Map([["b1", { id: "b1", starId: "star", channelId: "room", title: "Планёрка", room: null, startsAt: NOW }]]);
    await overlayAction({ toast: "knock:k1", action: "wait" }, meetings);
    await overlayAction({ toast: "knock:k1", action: "drop-table" }, meetings);
    await overlayAction({ toast: "knock:nope", action: "admit" }, meetings);
    await overlayAction({ toast: "invite:room2", action: "join" }, meetings);
    await overlayAction({ toast: "invite:room2", action: "dismiss" }, meetings);
    await overlayAction({ toast: "call:old", action: "accept" }, meetings);
    await overlayAction({ toast: "call:c1", action: "accept" }, meetings);
    await overlayAction({ toast: "myknock:m1", action: "cancel" }, meetings);
    await overlayAction({ toast: "meeting:b1", action: "dismiss" }, meetings);
    await overlayAction("мусор", meetings);
    expect(answer.mock.calls).toEqual([["k1", "wait"]]);
    expect(acceptInvite).toHaveBeenCalledWith(invite);
    expect(dismissInvite).toHaveBeenCalledWith(invite);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(cancelKnock).toHaveBeenCalledTimes(1);
    expect(meetings.size).toBe(0);
    useCallStore.setState({ phase: "idle", callId: null });
    useDoorsStore.setState({ knocks: {}, invites: [], myKnock: null, notice: null });
  });

  it("десктоп: стук вне комнаты, «Скоро встреча» от сервера, нажатая кнопка, перестановка и своё место", () => {
    let action: (value: unknown) => void = () => {};
    let moved: (value: unknown) => void = () => {};
    let placing: (on: boolean) => void = () => {};
    const setOverlay = vi.fn();
    const bridge = { setOverlay, onOverlayAction: (cb: typeof action) => { action = cb; return () => {}; },
      onOverlayMoved: (cb: typeof moved) => { moved = cb; return () => {}; }, onOverlayPlacing: (cb: typeof placing) => { placing = cb; return () => {}; } };
    useOverlayPrefs.setState({ ...PREFS, placing: false });
    useCallStore.setState({ phase: "idle", callId: null });
    useVoiceStore.setState({ status: "idle", channelId: null, starId: null, peers: [] });
    useDoorsStore.setState({ knocks: {}, invites: [], myKnock: null, notice: null });
    useStarsStore.setState({ details: {} });
    sockets.handlers.length = 0;
    startOverlay(bridge as unknown as DesktopBridge);
    expect(setOverlay).toHaveBeenLastCalledWith(null);
    const answer = vi.fn(async () => {});
    act(() => useDoorsStore.setState({ knocks: { k1: knockItem("k1", { receivedAt: Date.now() }) }, answer }));
    expect(setOverlay.mock.lastCall![0]).toMatchObject({ room: null, peers: [], toasts: [{ id: "knock:k1" }] });
    act(() => action({ toast: "knock:k1", action: "admit" }));
    expect(answer).toHaveBeenCalledWith("k1", "admit");
    act(() => useDoorsStore.setState({ knocks: {} }));
    expect(setOverlay).toHaveBeenLastCalledWith(null);
    // Сервер: через 10 минут встреча.
    act(() => sockets.handlers.forEach((h) => h({ type: "star_booking_soon", star_id: "star", channel_id: "room", booking_id: "b1",
      title: "Планёрка", room: "Переговорная", starts_at: new Date(Date.now() + 600_000).toISOString() })));
    expect(setOverlay.mock.lastCall![0].toasts.map((t: { id: string }) => t.id)).toEqual(["meeting:b1"]);
    act(() => useOverlayPrefs.getState().setPrefs({ alerts: false }));
    expect(setOverlay).toHaveBeenLastCalledWith(null);
    // «Переставить»: пока переставляют — оверлей есть и вне комнаты.
    act(() => placing(true));
    expect(setOverlay.mock.lastCall![0]).toMatchObject({ room: null, toasts: [] });
    act(() => moved({ display: 7, x: 300, y: 120 }));
    expect(useOverlayPrefs.getState()).toMatchObject({ corner: "custom", position: { x: 300, y: 120 }, display: 7 });
    expect(setOverlay.mock.lastCall![0]).toMatchObject({ corner: "custom", position: { x: 300, y: 120 }, display: 7 });
    act(() => moved({ x: "левее" }));
    expect(useOverlayPrefs.getState().position).toEqual({ x: 300, y: 120 });
    act(() => placing(false));
    expect(setOverlay).toHaveBeenLastCalledWith(null);
    useOverlayPrefs.setState({ ...PREFS, placing: false });
  });

  it("настройки: «Переставить», своё место и выбор угла, всплывашки — галочкой", () => {
    const placeOverlay = vi.fn();
    window.quazarDesktop = { setOverlay: vi.fn(), placeOverlay, onOverlayAction: () => () => {} } as unknown as DesktopBridge;
    useOverlayPrefs.setState({ ...PREFS, corner: "custom", position: { x: 300, y: 120 }, placing: false });
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(VoiceKeysSettings)));
    const corner = host.querySelector<HTMLSelectElement>('select[aria-label="Где показывать оверлей"]')!;
    expect(corner.value).toBe("custom");
    const place = [...host.querySelectorAll("button")].find((b) => b.textContent === "Переставить")!;
    act(() => Simulate.click(place));
    expect(placeOverlay).toHaveBeenLastCalledWith(true);
    act(() => useOverlayPrefs.setState({ placing: true }));
    expect(host.textContent).toContain("Перетащите оверлей мышью");
    act(() => Simulate.click([...host.querySelectorAll("button")].find((b) => b.textContent === "Готово")!));
    expect(placeOverlay).toHaveBeenLastCalledWith(false);
    act(() => Simulate.change(corner, { target: { value: "bottom-left" } } as never));
    expect(useOverlayPrefs.getState()).toMatchObject({ corner: "bottom-left", position: null });
    const alerts = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("стук, приглашения"))!.querySelector("input")!;
    act(() => Simulate.change(alerts, { target: { checked: false } } as never));
    expect(useOverlayPrefs.getState().alerts).toBe(false);
    act(() => root.unmount());
    useOverlayPrefs.setState({ ...PREFS, placing: false });
  });
});

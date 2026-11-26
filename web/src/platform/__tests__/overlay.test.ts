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
vi.mock("../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));

const { overlaySnapshot, callOverlaySnapshot, overlayHotkey, startOverlay, useOverlayPrefs, speakingOnly, OVERLAY_MAX_PEERS, SPEAKING_LINGER_MS } = await import("../overlay");
const { useCallStore } = await import("../../store/call");
const { useVoiceStore } = await import("../../store/voice");
const { useStarsStore } = await import("../../store/stars");
const { VoiceKeysSettings } = await import("../../components/constellation/VoicePanels");

const PREFS = { enabled: true, globalKeys: true, corner: "top-left" as const, onlySpeaking: false, scale: 1, opacity: 78, display: null };
const detail = { id: "star", channels: [{ id: "room", kind: "planet", name: "Переговорная" }] } as unknown as StarDetail;
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
      { name: "Анна", speaking: true, micOn: true, isLocal: true, deafened: true },
      // Микрофон выключен — «говорит» не показываем, даже если монитор что-то услышал.
      { name: "Боб", speaking: false, micOn: false, isLocal: false, deafened: false },
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
      { name: "Анна", speaking: false, micOn: false, isLocal: true, deafened: false },
      { name: "Боб", speaking: true, micOn: true, isLocal: false, deafened: false },
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

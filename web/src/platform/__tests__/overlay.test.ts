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

const { overlaySnapshot, overlayHotkey, startOverlay, useOverlayPrefs, OVERLAY_MAX_PEERS } = await import("../overlay");
const { useVoiceStore } = await import("../../store/voice");
const { useStarsStore } = await import("../../store/stars");
const { VoiceKeysSettings } = await import("../../components/constellation/VoicePanels");

const PREFS = { enabled: true, globalKeys: true, corner: "top-left" as const };
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
    expect(JSON.parse(memory.get("quazar_overlay")!)).toEqual({ enabled: true, globalKeys: true, corner: "bottom-right" });

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

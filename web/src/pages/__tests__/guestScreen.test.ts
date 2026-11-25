import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lk = vi.hoisted(() => ({
  Room: vi.fn(),
  Track: { Source: { Camera: "camera", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
  VideoPresets: { h180: {}, h360: {}, h720: { encoding: { maxBitrate: 1 } } },
  RoomEvent: Object.fromEntries([
    "ParticipantConnected", "ParticipantDisconnected", "ActiveSpeakersChanged", "TrackMuted", "TrackUnmuted",
    "LocalTrackPublished", "LocalTrackUnpublished", "TrackPublished", "TrackUnpublished", "ParticipantNameChanged",
    "Reconnected", "TrackSubscribed", "TrackUnsubscribed", "AudioPlaybackStatusChanged", "Disconnected",
    "ParticipantPermissionsChanged",
  ].map(key => [key, key])),
}));
vi.mock("livekit-client", () => lk);
vi.mock("../../api/client", () => ({ http: { get: vi.fn(), post: vi.fn() } }));
const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value) });
const auth = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (st: { token: string | null }) => unknown) => select(auth) }));
const { http } = await import("../../api/client");
const { useScreenAudio } = await import("../../store/screenAudio");
const { default: GuestPage } = await import("../GuestPage");

type FakeTrack = ReturnType<typeof mediaTrack>;
type Publication = { track: FakeTrack | null; source: string; isMuted: boolean };
function mediaTrack(kind: "audio" | "video", source: string) {
  let elements: HTMLMediaElement[] = [];
  let volume = 1;
  return {
    kind, source,
    attach: vi.fn((element?: HTMLMediaElement) => {
      const el = element ?? document.createElement(kind);
      el.volume = volume; elements.push(el); return el;
    }),
    detach: vi.fn((element?: HTMLMediaElement) => {
      const detached = element ? elements.filter(el => el === element) : elements;
      elements = element ? elements.filter(el => el !== element) : [];
      return detached;
    }),
    setVolume: vi.fn((value: number) => { volume = value; elements.forEach(el => { el.volume = value; }); }),
  };
}
function fakeRoom() {
  const publications = new Map<string, Publication>();
  const remote = { identity: "alice", name: "Алиса", isSpeaking: false, isMicrophoneEnabled: true,
    trackPublications: publications,
    getTrackPublication: (source: string) => publications.get(source) };
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const own = new Map<string, Publication>();
  const local = { identity: "guest-id", name: "Борис (гость)", isSpeaking: false, isMicrophoneEnabled: false,
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => { local.isMicrophoneEnabled = enabled; }),
    trackPublications: own,
    permissions: { canPublish: true, canPublishSources: [2] },
    publishTrack: vi.fn(async (_raw: unknown, opts: { source: string }) => {
      const pub = { track: mediaTrack("video", opts.source), source: opts.source, isMuted: false };
      own.set(opts.source, pub); return pub;
    }),
    unpublishTrack: vi.fn(async (track: FakeTrack) => {
      const pub = [...own.values()].find((p) => p.track === track);
      if (!pub) return;
      own.delete(pub.source); room.emit("LocalTrackUnpublished", pub, local);
    }),
  };
  const room = {
    publications, remote, localParticipant: local, remoteParticipants: new Map([["alice", remote]]),
    canPlaybackAudio: true,
    on(event: string, handler: (...args: any[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]); return room;
    },
    off(event: string, handler: (...args: any[]) => void) {
      handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler)); return room;
    },
    emit(event: string, ...args: any[]) { handlers.get(event)?.forEach(handler => handler(...args)); },
    /** Сервер поменял права гостя (как UpdateParticipant). */
    grant(sources: number[]) {
      local.permissions = { canPublish: sources.length > 0, canPublishSources: sources };
      room.emit("ParticipantPermissionsChanged", undefined, local);
    },
    connect: vi.fn(async () => {
      for (const pub of publications.values()) if (pub.track) room.emit("TrackSubscribed", pub.track, pub, remote);
    }),
    startAudio: vi.fn(async () => {}),
    disconnect: vi.fn(async () => { room.emit("Disconnected"); }),
  };
  return room;
}
let host: HTMLDivElement;
let root: Root;
let room: ReturnType<typeof fakeRoom>;
let listenOnly: boolean;
function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const result = [...within.querySelectorAll("button")].find(el => el.textContent?.trim() === text || el.getAttribute("aria-label") === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
function addTrack(track: FakeTrack) {
  const pub = { track, source: track.source, isMuted: false };
  room.publications.set(track.source, pub); return pub;
}
async function enter() {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ["/guest/invite-code"],
    future: { v7_startTransition: true, v7_relativeSplatPath: true } }, createElement(Routes, null,
      createElement(Route, { path: "/guest/:code", element: createElement(GuestPage) })))));
  const input = host.querySelector<HTMLInputElement>('[aria-label="Ваше имя"]')!;
  await act(async () => { input.value = "Борис"; Simulate.change(input); });
  await act(async () => Simulate.submit(host.querySelector("form")!));
}
beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); auth.token = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  listenOnly = false; room = fakeRoom();
  lk.Room.mockImplementation(function () { return room; });
  vi.mocked(http.get).mockImplementation(async () => ({ data: { star_name: "Работа", room_name: "Совещание", listen_only: listenOnly } }));
  vi.mocked(http.post).mockResolvedValue({ data: { token: "guest-token", url: "wss://media.example", identity: "guest-id" } });
  useScreenAudio.setState({ enabled: true, volume: 1 });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("guest camera", () => {
  let raw: { stop: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    raw = { stop: vi.fn(), addEventListener: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getVideoTracks: () => [raw] })) } });
    vi.mocked(http.post).mockImplementation(async (url: string) => {
      if (url.endsWith("/camera")) { setTimeout(() => room.grant([2, 1]), 0); return { data: null }; }
      return { data: { token: "guest-token", url: "wss://media.example", identity: "guest-id", secret: "s3cret" } };
    });
  });

  it("turns the guest's camera on with its key and off again", async () => {
    await enter();
    await act(async () => button("📷 Включить камеру").click());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(http.post).toHaveBeenCalledWith("/guest/invite-code/camera", { identity: "guest-id", secret: "s3cret", on: true });
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(raw, expect.objectContaining({ source: "camera", simulcast: true }));
    expect(host.querySelector('[aria-label="Камеры"]')?.textContent).toContain("Борис (гость) — вы");
    expect(host.querySelector<HTMLVideoElement>('[aria-label="Камеры"] video')!.style.transform).toBe("scaleX(-1)");

    await act(async () => button("📷 Выключить камеру").click());
    expect(http.post).toHaveBeenCalledWith("/guest/invite-code/camera", { identity: "guest-id", secret: "s3cret", on: false });
    expect(host.querySelector('[aria-label="Камеры"]')).toBeNull();
  });

  it("explains a denied camera without asking the server", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new DOMException("x", "NotAllowedError"));
    await enter();
    await act(async () => button("📷 Включить камеру").click());
    expect(http.post).not.toHaveBeenCalledWith("/guest/invite-code/camera", expect.anything());
    expect(host.textContent).toContain("Браузер не дал доступ к камере");
  });

  it("tells the guest when a moderator turns the camera off", async () => {
    await enter();
    await act(async () => button("📷 Включить камеру").click());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => room.grant([2]));
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalled();
    expect(host.textContent).toContain("Модератор выключил вашу камеру");
    expect(host.querySelector('[aria-label="Камеры"]')).toBeNull();
  });

  it("has no camera button in listen-only rooms", async () => {
    listenOnly = true;
    await enter();
    expect(() => button("📷 Включить камеру")).toThrow();
  });
});

describe("guest screen viewing", () => {
  it("shows an existing screen and cameras when joining without exposing screen publishing or moderation", async () => {
    const screen = mediaTrack("video", "screen_share"); addTrack(screen);
    const camera = mediaTrack("video", "camera"); addTrack(camera);
    await enter();
    expect(http.post).toHaveBeenCalledWith("/guest/invite-code/join", { name: "Борис" });
    expect(room.connect).toHaveBeenCalledWith("wss://media.example", "guest-token");
    expect(screen.attach).toHaveBeenCalledWith(host.querySelector("video"));
    // Камера Алисы — плиткой под показом экрана.
    expect(camera.attach).toHaveBeenCalledWith(host.querySelectorAll("video")[1]);
    expect(host.querySelector('[aria-label="Камеры"]')?.textContent).toContain("Алиса");
    expect(host.textContent).toContain("Алиса");
    expect(host.textContent).not.toContain("Остановить показ");
    expect(host.textContent).not.toContain("Показать экран");
    expect(host.textContent).not.toContain("Разрешить указатели");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("follows screen publication, subscription, loss and completion after joining", async () => {
    await enter(); expect(host.querySelector("video")).toBeNull();
    const track = mediaTrack("video", "screen_share");
    const publication: Publication = { source: "screen_share", track: null, isMuted: false };
    room.publications.set("screen_share", publication);
    await act(async () => room.emit("TrackPublished", publication, room.remote));
    expect(host.textContent).toContain("Алиса начинает показ экрана");
    publication.track = track;
    await act(async () => room.emit("TrackSubscribed", track, publication, room.remote));
    expect(host.querySelector("video")).not.toBeNull();
    expect(track.attach).toHaveBeenCalledOnce();
    publication.track = null;
    await act(async () => room.emit("TrackUnsubscribed", track, publication, room.remote));
    expect(host.querySelector("video")).toBeNull();
    expect(host.textContent).toContain("начинает показ");
    publication.track = track;
    await act(async () => room.emit("TrackSubscribed", track, publication, room.remote));
    expect(host.querySelector("video")).not.toBeNull();
    room.publications.delete("screen_share");
    await act(async () => room.emit("TrackUnpublished", publication, room.remote));
    expect(host.querySelector('[aria-label="Демонстрация экрана в комнате"]')).toBeNull();
  });

  it("keeps microphone and exit working inside the expanded screen and cleans up on exit", async () => {
    addTrack(mediaTrack("video", "screen_share"));
    const audio = mediaTrack("audio", "screen_share_audio"); addTrack(audio);
    await enter();
    const frame = host.querySelector("video")!.parentElement!.parentElement!;
    Object.defineProperty(frame, "requestFullscreen", { configurable: true, value: undefined });
    await act(async () => button("На весь экран").click());
    const expanded = document.querySelector('[role="dialog"][aria-label="Демонстрация экрана"]')!;
    expect(expanded).not.toBeNull();
    await act(async () => button("🎙 Выключить микрофон", expanded).click());
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(button("🔇 Включить микрофон", expanded)).toBeDefined();
    expect(expanded.querySelector('[aria-label="Громкость трансляции"]')).not.toBeNull();
    await act(async () => button("Выйти из Комнаты", expanded).click());
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
    expect(audio.detach).toHaveBeenCalled();
    expect(host.textContent).toContain("Вы вышли из Комнаты");
  });

  it("controls screen audio independently from voices and handles mute and new subscriptions", async () => {
    addTrack(mediaTrack("video", "screen_share"));
    const screenAudio = mediaTrack("audio", "screen_share_audio"), voice = mediaTrack("audio", "microphone");
    const publication = addTrack(screenAudio); addTrack(voice);
    await enter();
    const range = host.querySelector<HTMLInputElement>('[aria-label="Громкость трансляции"]')!;
    await act(async () => { range.value = "23"; Simulate.change(range); });
    expect(screenAudio.setVolume).toHaveBeenLastCalledWith(0.23);
    expect(voice.setVolume).not.toHaveBeenCalled();
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { toggle.checked = false; Simulate.change(toggle); });
    expect(screenAudio.setVolume).toHaveBeenLastCalledWith(0);
    await act(async () => { toggle.checked = true; Simulate.change(toggle); });
    expect(screenAudio.setVolume).toHaveBeenLastCalledWith(0.23);
    publication.isMuted = true;
    await act(async () => room.emit("TrackMuted", publication, room.remote));
    expect(range.disabled).toBe(true);
    publication.isMuted = false;
    await act(async () => room.emit("TrackUnmuted", publication, room.remote));
    expect(range.disabled).toBe(false);
    await act(async () => room.emit("TrackSubscribed", screenAudio, publication, room.remote));
    expect(screenAudio.attach).toHaveBeenCalledOnce();
    const replacement = mediaTrack("audio", "screen_share_audio");
    publication.track = replacement;
    await act(async () => {
      room.emit("TrackUnsubscribed", screenAudio, publication, room.remote);
      room.emit("TrackSubscribed", replacement, publication, room.remote);
    });
    expect(replacement.setVolume).toHaveBeenLastCalledWith(0.23);
  });

  it("silences everyone for the guest only and turns the guest's microphone off and back on", async () => {
    const screenAudio = mediaTrack("audio", "screen_share_audio"), voice = mediaTrack("audio", "microphone");
    addTrack(mediaTrack("video", "screen_share")); addTrack(screenAudio); addTrack(voice);
    await enter();
    expect(room.localParticipant.isMicrophoneEnabled).toBe(true);
    await act(async () => Simulate.click(button("🔇 Не слышать собеседников")));
    expect(voice.setVolume).toHaveBeenLastCalledWith(0);
    expect(screenAudio.setVolume).toHaveBeenLastCalledWith(0);
    expect(room.localParticipant.isMicrophoneEnabled).toBe(false);
    expect(button("🔈 Включить звук собеседников").getAttribute("aria-pressed")).toBe("true");
    // Новый собеседник, пока гость никого не слышит, тоже молчит.
    const late = mediaTrack("audio", "microphone");
    await act(async () => room.emit("TrackSubscribed", late, { track: late, source: "microphone", isMuted: false }, room.remote));
    expect(late.setVolume).toHaveBeenLastCalledWith(0);
    await act(async () => Simulate.click(button("🔈 Включить звук собеседников")));
    expect(voice.setVolume).toHaveBeenLastCalledWith(1);
    expect(screenAudio.setVolume).toHaveBeenLastCalledWith(1);
    expect(room.localParticipant.isMicrophoneEnabled).toBe(true);
  });

  it("brings the sound back when the guest turns the microphone on while silenced", async () => {
    const voice = mediaTrack("audio", "microphone");
    addTrack(voice); await enter();
    await act(async () => Simulate.click(button("🔇 Не слышать собеседников")));
    await act(async () => Simulate.click(button("🔇 Включить микрофон")));
    expect(voice.setVolume).toHaveBeenLastCalledWith(1);
    expect(room.localParticipant.isMicrophoneEnabled).toBe(true);
    expect(button("🔇 Не слышать собеседников")).toBeDefined();
  });

  it("allows screen viewing in listen-only rooms without requesting a microphone", async () => {
    listenOnly = true; addTrack(mediaTrack("video", "screen_share"));
    await enter();
    expect(host.querySelector("video")).not.toBeNull();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Включить микрофон");
    expect(host.textContent).not.toContain("Выключить микрофон");
    expect(button("Выйти из Комнаты")).toBeDefined();
  });

  it("still shows the screen when microphone access is denied", async () => {
    addTrack(mediaTrack("video", "screen_share"));
    room.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await enter();
    expect(host.querySelector("video")).not.toBeNull();
    expect(host.textContent).toContain("Микрофон не включился");
    expect(room.startAudio).toHaveBeenCalledOnce();
  });

  it("does not open a media connection if the page is left while the join request is pending", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(http.post).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await enter();
    await act(async () => root.render(null));
    await act(async () => resolve({ data: { token: "late-token", url: "wss://media.example" } }));
    expect(lk.Room).not.toHaveBeenCalled();
  });

  it("disconnects and detaches screen audio and video when leaving the guest page", async () => {
    const screen = mediaTrack("video", "screen_share"), audio = mediaTrack("audio", "screen_share_audio");
    addTrack(screen); addTrack(audio); await enter();
    await act(async () => root.render(null));
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(screen.detach).toHaveBeenCalled();
    expect(audio.detach).toHaveBeenCalledOnce();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("cleans up a failed connection before offering another attempt", async () => {
    room.connect.mockRejectedValueOnce(new Error("connection failed"));
    await enter();
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(host.querySelector("video")).toBeNull();
    expect(button("Войти в Комнату").disabled).toBe(false);
    expect(host.textContent).toContain("Не удалось войти");
  });
});

describe("guest link with a Quazar account", () => {
  // Подмену localStorage снимает afterEach каждого теста — ставим свою заново.
  const pending = () => memory.get("quazar_pending_guest_link");
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value) });
  });

  async function open() {
    await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ["/guest/invite-code"],
      future: { v7_startTransition: true, v7_relativeSplatPath: true } }, createElement(Routes, null,
        createElement(Route, { path: "/guest/:code", element: createElement(GuestPage) }),
        createElement(Route, { path: "/", element: "приложение" }),
        createElement(Route, { path: "/auth", element: "вход" })))));
  }

  it("opens the room in the app when signed in", async () => {
    auth.token = "jwt";
    await open();
    expect(pending()).toBe("invite-code");
    expect(host.textContent).toBe("приложение");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("offers to sign in and keeps the link for after that", async () => {
    await open();
    expect(host.querySelector('[aria-label="Ваше имя"]')).not.toBeNull();
    await act(async () => button("Войдите").click());
    expect(pending()).toBe("invite-code");
    expect(host.textContent).toBe("вход");
  });
});

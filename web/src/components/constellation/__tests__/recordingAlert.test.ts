import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarDetail, VoicePresence } from "../../../api/stars";

const memory = new Map<string, string>();
const storage = { getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, value: string) => void memory.set(k, value), removeItem: (k: string) => void memory.delete(k) };
vi.stubGlobal("localStorage", storage);
vi.stubGlobal("sessionStorage", storage);
vi.mock("../../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));

const { recordingElapsed, RecordingAlertHost, resetRecordingAlertsForTests } = await import("../RecordingAlert");
const { VoiceBar } = await import("../VoiceBar");
const { roomRecording } = await import("../../../pages/GuestPage");
const { useStarsStore } = await import("../../../store/stars");
const { useVoiceStore } = await import("../../../store/voice");
const { useAuthStore } = await import("../../../store/auth");

let host: HTMLDivElement;
let root: Root;

function star(voice: Record<string, VoicePresence[]>): StarDetail {
  return {
    id: "star", name: "Офис", kind: "work", my_role: "member",
    channels: [{ id: "room", kind: "planet", name: "Переговорная" }, { id: "hall", kind: "planet", name: "Зал" }],
    members: [
      { user: { id: "me", username: "me", display_name: "Анна" }, role: "member" },
      { user: { id: "bob", username: "bob", display_name: "Боб" }, role: "moderator" },
    ],
    voice,
  } as unknown as StarDetail;
}

function recorder(user_id: string, since: string): VoicePresence {
  return { user_id, joined_at: since, server_muted: false, recording: true, recording_since: since } as VoicePresence;
}

function inRoom(channelId: string, voice: Record<string, VoicePresence[]>) {
  act(() => {
    useStarsStore.setState({ details: { star: star(voice) } });
    useVoiceStore.setState({ status: "connected", starId: "star", channelId });
  });
}

function render(node: ReturnType<typeof createElement>) {
  act(() => root.render(node));
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function click(text: string) {
  const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  act(() => Simulate.click(button));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  memory.clear();
  resetRecordingAlertsForTests();
  useAuthStore.setState({ user: { id: "me" } as never });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => useVoiceStore.setState({ status: "idle", starId: null, channelId: null }));
});

describe("recordingElapsed", () => {
  it("минуты и секунды, после часа — часы", () => {
    const start = Date.parse("2026-11-26T10:00:00Z");
    expect(recordingElapsed(start, start + 7_000)).toBe("0:07");
    expect(recordingElapsed("2026-11-26T10:00:00Z", start + (12 * 60 + 34) * 1000)).toBe("12:34");
    expect(recordingElapsed(start, start + (3600 + 2 * 60 + 3) * 1000)).toBe("1:02:03");
    expect(recordingElapsed(start, start - 5000)).toBe("0:00");
  });
});

describe("окно «Ведётся запись разговора»", () => {
  it("показывается, закрывается «Понятно» и снова — только для новой записи", () => {
    inRoom("room", { room: [recorder("bob", "2026-11-26T10:00:00Z")] });
    render(createElement(RecordingAlertHost));
    expect(dialog()?.textContent).toContain("Ведётся запись разговора");
    expect(dialog()?.textContent).toContain("Боб записывает разговор");
    expect(dialog()?.textContent).toContain("Больше не показывать");
    click("Понятно");
    expect(dialog()).toBeNull();
    // Та же запись — окно не возвращается; новая запись в той же комнате — возвращается.
    inRoom("room", { room: [recorder("bob", "2026-11-26T10:00:00Z")] });
    expect(dialog()).toBeNull();
    inRoom("room", { room: [recorder("bob", "2026-11-26T11:00:00Z")] });
    expect(dialog()).not.toBeNull();
  });

  it("«Больше не показывать» — только для этой комнаты", () => {
    inRoom("room", { room: [recorder("bob", "2026-11-26T10:00:00Z")] });
    render(createElement(RecordingAlertHost));
    const box = dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => Simulate.change(box, { target: { checked: true } } as never));
    click("Понятно");
    inRoom("room", { room: [recorder("bob", "2026-11-26T12:00:00Z")] });
    expect(dialog()).toBeNull();
    // В другой комнате окно показывается.
    inRoom("hall", { hall: [recorder("bob", "2026-11-26T12:00:00Z")] });
    expect(dialog()?.textContent).toContain("Ведётся запись разговора");
  });

  it("тому, кто записывает, окно не нужно", () => {
    inRoom("room", { room: [recorder("me", "2026-11-26T10:00:00Z")] });
    render(createElement(RecordingAlertHost));
    expect(dialog()).toBeNull();
  });
});

describe("плашка «Вы в Комнате»", () => {
  it("показывает, кто записывает и сколько идёт запись", () => {
    const since = new Date(Date.now() - 65_000).toISOString();
    inRoom("room", { room: [recorder("bob", since)] });
    render(createElement(VoiceBar, {}));
    const badge = host.querySelector('[role="status"]')!;
    expect(badge.textContent).toMatch(/Идёт запись · Боб · 1:0[5-7]/);
  });
});

describe("гость по ссылке", () => {
  it("читает из метаданных комнаты, кто записывает и с какого времени", () => {
    expect(roomRecording(JSON.stringify({ active_since: "x" }))).toBeNull();
    expect(roomRecording(JSON.stringify({ recording: true, recording_by: "bob", recording_since: "2026-11-26T10:00:00Z" })))
      .toEqual({ by: "bob", since: "2026-11-26T10:00:00Z" });
    expect(roomRecording(JSON.stringify({ recording: true }))).toEqual({ by: null, since: null });
    expect(roomRecording("{oops")).toBeNull();
  });
});

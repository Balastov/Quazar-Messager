import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarChannel, StarDetail, VoicePresence } from "../../../api/stars";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
vi.mock("../../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));

const { splitHidden } = await import("../rules");
const { default: ChannelDialog } = await import("../ChannelDialog");
const { default: ChannelSidebar } = await import("../ChannelSidebar");
const { useStarsStore } = await import("../../../store/stars");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const room = (patch: Partial<StarChannel> = {}): StarChannel => ({
  id: "room", star_id: "star", kind: "planet", name: "Переговорная", position: 0, capacity: 6, room_kind: "meeting",
  access: "invite", map_x: null, map_y: null, map_w: null, map_h: null, ...patch,
} as StarChannel);

const person = (user_id: string, patch: Partial<VoicePresence> = {}): VoicePresence =>
  ({ user_id, joined_at: "2026-11-26T10:00:00Z", server_muted: false, ...patch });

function checkbox(): HTMLInputElement | undefined {
  return [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Скрывать, кто в комнате"))?.querySelector("input") ?? undefined;
}

describe("«Скрывать, кто в комнате» в настройках комнаты", () => {
  it("есть только у рабочих комнат со стуком и уходит на сервер", async () => {
    const updateChannel = vi.fn(async () => {});
    useStarsStore.setState({ updateChannel });
    act(() => root.render(createElement(ChannelDialog, { starKind: "work", kind: "planet", channel: room({ access: "open" }), onClose: () => {} })));
    expect(checkbox()).toBeUndefined();
    const select = [...host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "invite"))!;
    act(() => Simulate.change(select, { target: { value: "invite" } } as never));
    expect(checkbox()).toBeDefined();
    expect(host.textContent).toContain("Всех видят владелец Звезды, админы, модераторы и те, кто сам в комнате");
    act(() => Simulate.change(checkbox()!, { target: { checked: true } } as never));
    await act(async () => Simulate.submit(host.querySelector("form")!));
    expect(updateChannel).toHaveBeenCalledWith("room", expect.objectContaining({ access: "invite", hide_people: true }));

    // Вернули свободный вход — настройка не действует и выключается.
    updateChannel.mockClear();
    act(() => root.render(createElement(ChannelDialog, { key: "2", starKind: "work", kind: "planet", channel: room({ hide_people: true }), onClose: () => {} })));
    const select2 = [...host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "invite"))!;
    act(() => Simulate.change(select2, { target: { value: "open" } } as never));
    expect(checkbox()).toBeUndefined();
    await act(async () => Simulate.submit(host.querySelector("form")!));
    expect(updateChannel).toHaveBeenCalledWith("room", expect.objectContaining({ access: "open", hide_people: false }));
  });

  it("в игровых Звёздах её нет", () => {
    act(() => root.render(createElement(ChannelDialog, { starKind: "gaming", kind: "planet", channel: room(), onClose: () => {} })));
    expect(checkbox()).toBeUndefined();
  });
});

describe("скрытые люди в списке комнат", () => {
  it("видно, сколько человек внутри, но не кто", () => {
    expect(splitHidden([person("a"), person("hidden-1", { hidden: true })])).toEqual({ shown: [person("a")], hidden: 1 });
    const detail = {
      id: "star", name: "Офис", kind: "work", my_role: "member", my_permissions: [], channels: [room({ floor_id: "f1" })], floors: [{ id: "f1", name: "1 этаж", position: 0, version: 1 }],
      members: [{ user: { id: "me", username: "me", display_name: "Я" }, role: "member" }],
      voice: { room: [person("hidden-1", { hidden: true }), person("hidden-2", { hidden: true })] },
    } as unknown as StarDetail;
    act(() => root.render(createElement(ChannelSidebar, {
      detail, activeChannelId: null, onOpenFiles: () => {}, onOpenChannel: () => {}, onAddChannel: () => {},
      onEditChannel: () => {}, onOpenSettings: () => {}, onToggleMembers: () => {}, membersOpen: false,
    })));
    expect(host.textContent).toContain("2/6");
    // Вместо двух безымянных «Участников» — одна строка «скрыто».
    const rows = [...host.querySelectorAll('[title^="Кто внутри, видят"]')].map((r) => r.textContent);
    expect(rows).toEqual(["🙈Кто внутри — скрыто"]);
  });
});

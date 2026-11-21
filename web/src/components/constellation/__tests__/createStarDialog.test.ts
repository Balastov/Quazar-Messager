import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarLimits } from "../../../api/stars";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, value: string) => void memory.set(k, value), removeItem: (k: string) => void memory.delete(k) });
vi.mock("../../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));
vi.mock("../../../api/premium", () => ({ premiumApi: {
  get: vi.fn(() => Promise.resolve({ active: false, kind: null, forever: false, until: null, trial_available: true,
    trial_unavailable_reason: null, star_limits: { free: 2, trial: 3, premium: 5 } })),
  startTrial: vi.fn(),
} }));

const { useStarsStore } = await import("../../../store/stars");
const { default: CreateStarDialog } = await import("../CreateStarDialog");

let host: HTMLDivElement;
let root: Root;

function limits(over: Partial<StarLimits> = {}): StarLimits {
  return { max_owned_stars: 2, owned_stars: 0, max_star_members: 100, gaming_max_satellites: 3, gaming_max_planets: 5,
    planet_max_capacity: 50, room_kinds: {} as StarLimits["room_kinds"], ...over };
}

function button(text: string) {
  const found = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`Button missing: ${text}`);
  return found as HTMLButtonElement;
}

async function open(over: Partial<StarLimits>) {
  useStarsStore.setState({ limits: limits(over) });
  await act(async () => root.render(createElement(CreateStarDialog, { onClose: () => {} })));
  const input = host.querySelector("input")!;
  await act(async () => Simulate.change(input, { target: { value: "Офис" } as unknown as EventTarget }));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("CreateStarDialog", () => {
  it("offers Premium instead of creating a work star without it", async () => {
    await open({ can_create_work: false });
    expect(button("Работа").textContent).toContain("с Premium");
    await act(async () => button("Работа").click());
    expect(host.textContent).toContain("Звёзды «Работа» создаются с Quazar Premium");
    expect(button("Создать Звезду").disabled).toBe(true);
    // Игровую — можно.
    await act(async () => button("Игры").click());
    expect(button("Создать Звезду").disabled).toBe(false);
    expect(host.textContent).not.toContain("создаются с Quazar Premium");
  });

  it("creates work stars as before with Premium", async () => {
    await open({ can_create_work: true });
    expect(button("Работа").textContent).not.toContain("с Premium");
    await act(async () => button("Работа").click());
    expect(button("Создать Звезду").disabled).toBe(false);
  });
});

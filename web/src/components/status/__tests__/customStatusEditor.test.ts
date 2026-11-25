import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let current: { icon: string | null; text: string; until: string | null } | null = null;
vi.mock("../../../store/presence", () => ({
  useCustomStatus: () => current,
  setMyCustomStatus: vi.fn(async () => {}),
}));
vi.mock("../../../store/auth", () => ({
  useAuthStore: (pick: (st: { user: { id: string } }) => unknown) => pick({ user: { id: "me" } }),
}));

const { default: CustomStatusEditor } = await import("../CustomStatusEditor");
const { toLocalInput } = await import("../../../chat/when");

let host: HTMLDivElement;
let root: Root;
const now = new Date(2026, 10, 26, 14, 7);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function pickCustom() {
  await act(async () => root.render(createElement(CustomStatusEditor)));
  const select = host.querySelector("select")!;
  await act(async () => { select.value = "custom"; Simulate.change(select); });
  return host.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
}

describe("custom status: own date and time", () => {
  it("is prefilled with now plus 30 minutes", async () => {
    expect((await pickCustom()).value).toBe("2026-11-26T14:37");
  });

  it("replaces a time that has already passed", async () => {
    current = { icon: "bed", text: "Сплю", until: new Date(now.getTime() - 60_000).toISOString() };
    await act(async () => root.render(createElement(CustomStatusEditor)));
    const select = host.querySelector("select")!;
    await act(async () => { select.value = "none"; Simulate.change(select); });
    expect((await pickCustom()).value).toBe("2026-11-26T14:37");
  });

  it("keeps a future time the user already has", async () => {
    const until = new Date(now.getTime() + 3 * 3600_000);
    current = { icon: "bed", text: "Сплю", until: until.toISOString() };
    await act(async () => root.render(createElement(CustomStatusEditor)));
    const select = host.querySelector("select")!;
    await act(async () => { select.value = "none"; Simulate.change(select); });
    expect((await pickCustom()).value).toBe(toLocalInput(until));
  });
});

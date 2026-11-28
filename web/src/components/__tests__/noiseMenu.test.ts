import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => {
  const state = {
    engine: "gtcrn" as "rnnoise" | "gtcrn",
    listeners: new Set<() => void>(),
    set: vi.fn((engine: "rnnoise" | "gtcrn") => {
      state.engine = engine;
      state.listeners.forEach((listener) => listener());
    }),
  };
  return state;
});
vi.mock("../../calls/noiseSuppression", () => ({
  getNoiseEnginePref: () => prefs.engine,
  setNoiseEnginePref: prefs.set,
  subscribeNoiseEngine: (listener: () => void) => {
    prefs.listeners.add(listener);
    return () => prefs.listeners.delete(listener);
  },
}));

const { useNoiseMenu } = await import("../NoiseMenu");

let host: HTMLDivElement, root: Root;
const toggle = vi.fn();
let enabled = true;
let unavailable = false;

function Harness() {
  const noise = useNoiseMenu({ enabled, toggle, unavailable });
  return createElement("div", null,
    createElement("button", { id: "noise", onClick: noise.onButtonClick, "aria-expanded": noise.expanded }, `mode:${noise.mode}`),
    noise.menu);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prefs.engine = "gtcrn"; enabled = true; unavailable = false;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = () => act(async () => root.render(createElement(Harness)));
const anchor = () => host.querySelector<HTMLButtonElement>("#noise")!;
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
const item = (title: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  .find((el) => el.textContent?.startsWith(title))!;
const open = () => act(async () => anchor().click());

it("opens a menu with three modes; GTCRN is the default and checked", async () => {
  await render();
  expect(menu()).toBeNull();
  await open();
  expect(menu()).not.toBeNull();
  expect(host.contains(menu())).toBe(false); // в body, поверх стеклянных панелей
  expect([...document.body.querySelectorAll('[role="menuitemradio"]')].map((el) => el.querySelector("span + span span")?.firstChild?.textContent))
    .toEqual(["Без обработки", "RNNoise", "GTCRN"]);
  expect(item("GTCRN").getAttribute("aria-checked")).toBe("true");
  expect(item("GTCRN").textContent).toContain("по умолчанию");
  expect(document.activeElement).toBe(item("GTCRN"));
  expect(anchor().getAttribute("aria-expanded")).toBe("true");
});

it("picking RNNoise switches the engine and closes the menu", async () => {
  await render(); await open();
  await act(async () => item("RNNoise").click());
  expect(prefs.set).toHaveBeenCalledWith("rnnoise");
  expect(toggle).not.toHaveBeenCalled();
  expect(menu()).toBeNull();
  expect(anchor().textContent).toBe("mode:rnnoise");
});

it("«Без обработки» turns noise suppression off; picking a network turns it back on", async () => {
  await render(); await open();
  await act(async () => item("Без обработки").click());
  expect(toggle).toHaveBeenCalledOnce();
  expect(prefs.set).not.toHaveBeenCalled();

  enabled = false; toggle.mockClear();
  await render();
  expect(anchor().textContent).toBe("mode:off");
  await open();
  expect(item("Без обработки").getAttribute("aria-checked")).toBe("true");
  await act(async () => item("GTCRN").click());
  expect(toggle).toHaveBeenCalledOnce();
  expect(prefs.set).not.toHaveBeenCalled(); // GTCRN и так выбрана
});

it("closes on outside click, Escape and a second press of the button", async () => {
  await render(); await open();
  await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  expect(menu()).toBeNull();
  await open();
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(menu()).toBeNull();
  await open();
  await act(async () => { anchor().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); anchor().click(); });
  expect(menu()).toBeNull();
});

it("arrow keys move between modes", async () => {
  await render(); await open();
  const press = (key: string) => act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await press("ArrowDown");
  expect(document.activeElement).toBe(item("Без обработки"));
  await press("ArrowUp");
  expect(document.activeElement).toBe(item("GTCRN"));
});

it("explains when the network did not start on this device", async () => {
  unavailable = true;
  await render(); await open();
  expect(menu()!.textContent).toContain("нейросеть не запустилась");
});

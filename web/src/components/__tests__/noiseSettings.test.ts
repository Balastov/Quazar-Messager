import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({ gate: null as number | null }));
vi.mock("../../calls/noiseSuppression", () => ({
  NOISE_ENGINES: ["rnnoise", "gtcrn"],
  NoiseSuppressedMic: { create: vi.fn() },
}));
vi.mock("../NoiseControls", () => ({
  default: (props: { live: boolean }) => createElement("p", null, `controls live=${props.live}`),
  GateMeterBar: () => null,
  formatDb: (db: number) => `${db} дБ`,
  useMicGate: () => ({ gateDb: prefs.gate, level: prefs.gate ?? -50 }),
}));
vi.mock("../../calls/devices", () => ({ getMicrophone: vi.fn() }));
const call = vi.hoisted(() => ({ noiseSuppression: true, phase: "idle", toggleNoiseSuppression: vi.fn() }));
vi.mock("../../store/call", () => ({ useCallStore: (selector: (state: typeof call) => unknown) => selector(call) }));
const voice = vi.hoisted(() => ({ status: "idle" }));
vi.mock("../../store/voice", () => ({
  micErrorText: () => "",
  useVoiceStore: (selector: (state: typeof voice) => unknown) => selector(voice),
}));

const { default: NoiseSettings } = await import("../settings/NoiseSettings");

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prefs.gate = null; call.noiseSuppression = true; call.phase = "idle"; voice.status = "idle";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = () => act(async () => root.render(createElement(NoiseSettings)));
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

it("outside a call offers voice tuning (with the gate on) and the comparison recording", async () => {
  await render();
  expect(host.textContent).toContain("controls live=false");
  expect(button("Настроить по голосу")).toBeUndefined();
  prefs.gate = -45;
  await render();
  expect(button("Настроить по голосу")!.disabled).toBe(false);
  expect(button("Записать пример")!.disabled).toBe(false);
  expect(host.textContent).toContain("«Микрофон и динамик»");
});

it("during a call shows the live level instead and does not open the microphone", async () => {
  prefs.gate = -45; call.phase = "active";
  await render();
  expect(host.textContent).toContain("controls live=true");
  expect(button("Настроить по голосу")).toBeUndefined();
  expect(button("Записать пример")!.disabled).toBe(true);
});

it("without noise suppression there is nothing to compare", async () => {
  call.noiseSuppression = false;
  await render();
  expect(button("Записать пример")).toBeUndefined();
});

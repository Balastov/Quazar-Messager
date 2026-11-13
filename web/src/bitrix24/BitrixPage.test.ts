import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("./context", () => ({ launchContext: mocks.launch }));
import BitrixPage from "./BitrixPage";

let root: Root, host: HTMLDivElement;
const stop = vi.fn();
const getUserMedia = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks();
  mocks.launch.mockResolvedValue({ portal: "https://is4business.bitrix24.ru", display_name: "Иван", mode: "launch" });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(createElement(BitrixPage))); }
async function camera() { await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Камера")!.click()); }

it("opens a verified context without asking for devices; camera closes automatically", async () => {
  await mount(); expect(host.textContent).toContain("Иван"); expect(getUserMedia).not.toHaveBeenCalled();
  await camera(); expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: true });
  await act(async () => vi.advanceTimersByTime(8000)); expect(stop).toHaveBeenCalledOnce();
});
it("releases a device granted after the embedded view was closed", async () => {
  let grant!: (stream: unknown) => void;
  getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  await mount(); await camera(); await act(async () => root.render(null));
  await act(async () => grant({ getTracks: () => [{ stop }] })); expect(stop).toHaveBeenCalledOnce();
});
it("explains permission denial without claiming successful capture", async () => {
  getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  await mount(); await camera(); expect(host.textContent).toContain("Доступ не получен");
});
it("never exposes installation completion for an ordinary launch", async () => {
  await mount(); expect(host.textContent).not.toContain("Завершить установку");
});

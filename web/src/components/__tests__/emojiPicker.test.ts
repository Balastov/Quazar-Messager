import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StickerPicker from "../StickerPicker";
import StarPicker from "../constellation/StarPicker";
import { useStickersStore } from "../../store/stickers";
import type { StarAsset } from "../../api/stars";
vi.mock("../Sticker", () => ({ default: ({ emoji }: { emoji: string }) => createElement("span", null, emoji) }));
let root: Root, host: HTMLDivElement;
const emoji = vi.fn(), sticker = vi.fn(), close = vi.fn();
const item = { id: "hello", emoji: "👋", url: "/test-sticker.json" };
const pack = { id: "sample", version: 1, title: "Пример", author: "", license: "", license_url: "", source_url: "", stickers: [item] };
const original = useStickersStore.getState();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); emoji.mockClear(); sticker.mockClear(); close.mockClear();
  useStickersStore.setState({ packs: [pack], loaded: true, load: vi.fn().mockResolvedValue(undefined) });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useStickersStore.setState(original); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(createElement(StickerPicker, { onPick: sticker, onEmoji: emoji, onClose: close }))); }
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(element => element.textContent === label || element.getAttribute("aria-label") === label)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
it("opens emoji first and inserts a smile without sending a sticker", async () => {
  await mount(); expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Смайлы");
  await click("Смайл 😀"); expect(emoji).toHaveBeenCalledWith("😀"); expect(sticker).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Отправить стикер 👋"]')).toBeNull();
});
it("switches to sticker packs and sends the selected sticker", async () => {
  await mount(); await click("Стикеры"); await click("Отправить стикер 👋");
  expect(sticker).toHaveBeenCalledWith("sample", item); expect(emoji).not.toHaveBeenCalled();
});
it("keeps Star emoji and Star stickers in their respective tabs", async () => {
  const assets = [{ id: "emoji-star", kind: "emoji", name: "wave", url: "/wave.png" }, { id: "sticker-star", kind: "sticker", name: "Звезда", url: "/star.png" }] as StarAsset[];
  await act(async () => root.render(createElement(StarPicker, { assets, onEmoji: emoji, onSticker: sticker, onClose: close })));
  await click("Смайл :wave:"); expect(emoji).toHaveBeenCalledWith(":wave:");
  await click("Стикеры"); await click("Отправить стикер Звезда"); expect(sticker).toHaveBeenCalledWith("STK1:star/sticker-star");
  await click("Пример"); await click("Отправить стикер 👋"); expect(sticker).toHaveBeenCalledWith("STK1:sample/hello");
});
it("supports keyboard tabs and Escape", async () => {
  await mount(); const tab = host.querySelector('[role="tab"]')!;
  await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Стикеры");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(close).toHaveBeenCalledOnce();
});

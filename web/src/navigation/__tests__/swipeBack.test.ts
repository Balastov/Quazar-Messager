import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SwipeBack from "../SwipeBack";
let root: Root, host: HTMLDivElement, surface: HTMLDivElement;
const back = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("max-width") })));
  back.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(SwipeBack, { onBack: back, screenId: "first", children: createElement("div", { id: "content" }, "Чат") })));
  surface = host.firstElementChild as HTMLDivElement;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function touch(type: string, x: number, y: number, target: Element = surface, count = 1) {
  const point = { identifier: 1, clientX: x, clientY: y };
  const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : Array(count).fill(point) as Touch[], changedTouches: [point] as Touch[] });
  target.dispatchEvent(event); return event;
}
it("returns on a right swipe and cancels the release click", () => {
  touch("touchstart", 30, 200); expect(touch("touchmove", 160, 205).defaultPrevented).toBe(true);
  expect(touch("touchend", 165, 206).defaultPrevented).toBe(true); expect(back).toHaveBeenCalledOnce(); expect(surface.style.transform).toBe("");
});
it("leaves vertical scrolling and left swipes alone", () => {
  touch("touchstart", 30, 200); expect(touch("touchmove", 35, 300).defaultPrevented).toBe(false); touch("touchend", 100, 320);
  touch("touchstart", 200, 200); touch("touchmove", 40, 205); touch("touchend", 35, 205);
  expect(back).not.toHaveBeenCalled();
});
it("does not navigate on a short swipe", () => {
  touch("touchstart", 30, 200); touch("touchmove", 75, 200); touch("touchend", 75, 200); expect(back).not.toHaveBeenCalled();
});
it.each(["textarea", "button", "pre"])("does not hijack interactions with %s", async tag => {
  await act(async () => root.render(createElement(SwipeBack, { onBack: back, children: createElement(tag, null, tag === "textarea" ? undefined : "Контроль") })));
  surface = host.firstElementChild as HTMLDivElement; const control = surface.firstElementChild!;
  touch("touchstart", 30, 200, control); expect(touch("touchmove", 180, 200, control).defaultPrevented).toBe(false); touch("touchend", 180, 200, control);
  expect(back).not.toHaveBeenCalled();
});
it("cancels an unfinished gesture when the screen changes or touch is cancelled", async () => {
  touch("touchstart", 30, 200); touch("touchmove", 180, 200);
  await act(async () => root.render(createElement(SwipeBack, { onBack: back, screenId: "second", children: "Другой экран" })));
  surface = host.firstElementChild as HTMLDivElement; touch("touchend", 180, 200); expect(back).not.toHaveBeenCalled();
  touch("touchstart", 30, 200); touch("touchmove", 180, 200); touch("touchcancel", 180, 200); touch("touchend", 180, 200); expect(back).not.toHaveBeenCalled();
});
it("finishes a slow horizontal drag once the intent is clear", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  touch("touchstart", 30, 200); touch("touchmove", 60, 201);
  now.mockReturnValue(2_500); touch("touchmove", 150, 203);
  now.mockReturnValue(4_000); touch("touchend", 170, 204);
  expect(back).toHaveBeenCalledOnce(); now.mockRestore();
});
it("does not start a gesture that stays ambiguous for too long", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  touch("touchstart", 30, 200); touch("touchmove", 38, 202);
  now.mockReturnValue(1_900); touch("touchmove", 170, 204); touch("touchend", 175, 204);
  expect(back).not.toHaveBeenCalled(); now.mockRestore();
});

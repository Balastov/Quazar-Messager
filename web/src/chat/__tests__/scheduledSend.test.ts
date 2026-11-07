import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScheduledSend } from "../useScheduledSend";

let root: Root, host: HTMLDivElement, button: HTMLButtonElement;
const open = vi.fn(), submit = vi.fn();
function Fixture({ scope = "first" }: { scope?: string }) {
  const props = useScheduledSend(open, scope);
  return createElement("form", { onSubmit: (event: React.FormEvent) => { event.preventDefault(); submit(); } },
    createElement("button", { type: "submit", ...props }, "Отправить"));
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); open.mockClear(); submit.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Fixture))); button = host.querySelector("button")!;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function pointer(type: string, x = 10) {
  await act(async () => button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, clientX: x, clientY: 10 })));
}
it("a normal tap still submits immediately", async () => {
  await pointer("pointerdown"); await pointer("pointerup"); await act(async () => button.click());
  expect(submit).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
});
it("a hold opens scheduling once and never submits on release", async () => {
  await pointer("pointerdown"); await act(async () => vi.advanceTimersByTime(450));
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(async () => button.dispatchEvent(menu));
  await pointer("pointerup");
  const release = new TouchEvent("touchend", { bubbles: true, cancelable: true });
  await act(async () => button.dispatchEvent(release));
  expect(release.defaultPrevented).toBe(true);
  await act(async () => button.click());
  expect(menu.defaultPrevented).toBe(true); expect(open).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  await pointer("pointerdown"); await pointer("pointerup"); await act(async () => button.click());
  expect(submit).toHaveBeenCalledOnce();
});
it("dragging cancels both the hold and the captured release click", async () => {
  await pointer("pointerdown"); await pointer("pointermove", 35);
  await act(async () => vi.advanceTimersByTime(600));
  await pointer("pointerup"); await act(async () => button.click());
  expect(open).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});
it("right click offers scheduling without submitting", async () => {
  await act(async () => button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(open).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
});
it("offers a keyboard alternative while retaining Enter for normal submission", async () => {
  const shortcut = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => button.dispatchEvent(shortcut));
  expect(shortcut.defaultPrevented).toBe(true); expect(open).toHaveBeenCalledOnce();
  await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await act(async () => button.click()); expect(submit).toHaveBeenCalledOnce();
});
it("unmounting cancels a pending hold", async () => {
  await pointer("pointerdown"); await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTime(600));
  expect(open).not.toHaveBeenCalled();
});
it("switching chats cancels a pending hold", async () => {
  await pointer("pointerdown");
  await act(async () => root.render(createElement(Fixture, { scope: "another-chat" })));
  await act(async () => vi.advanceTimersByTime(600));
  expect(open).not.toHaveBeenCalled();
  await pointer("pointerup"); await act(async () => button.click());
  expect(submit).not.toHaveBeenCalled();
});

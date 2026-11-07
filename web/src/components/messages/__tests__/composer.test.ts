import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ComposerInput, { type ComposerHandle } from "../ComposerInput";

let root: Root, host: HTMLDivElement, compact: boolean, contentHeight: number;
let viewport: EventTarget & { height: number };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  compact = true; contentHeight = 500;
  viewport = Object.assign(new EventTarget(), { height: 700 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: compact })));
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => contentHeight);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(value = "Длинное сообщение", extra = {}) {
  await act(async () => root.render(createElement(ComposerInput, { value, onValueChange: vi.fn(),
    style: { boxSizing: "border-box", lineHeight: "22px", fontSize: "16px", padding: "8px 0", border: "0" }, ...extra })));
  return host.querySelector("textarea")!;
}
it("caps a long mobile message and enables scrolling, then shrinks when cleared", async () => {
  const field = await render();
  expect(field.style.height).toBe("82px"); expect(field.style.overflowY).toBe("auto");
  contentHeight = 40; await render("");
  expect(field.style.height).toBe("40px"); expect(field.style.overflowY).toBe("hidden");
});
it("recalculates the limit when only the visual viewport changes with the keyboard", async () => {
  const field = await render();
  viewport.height = 200;
  await act(async () => viewport.dispatchEvent(new Event("resize")));
  expect(field.style.maxHeight).toBe("60px"); expect(field.style.height).toBe("60px");
  viewport.height = 700;
  await act(async () => viewport.dispatchEvent(new Event("resize")));
  expect(field.style.height).toBe("82px");
});
it("restores the desktop limit after rotating or widening the viewport", async () => {
  const field = await render(); compact = false;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(field.style.height).toBe("200px");
});
it("respects a smaller explicit limit and lets the notes editor opt out", async () => {
  const field = await render("text", { maxHeight: 60 }); expect(field.style.height).toBe("60px");
  await render("document", { maxHeight: 100_000, limitToViewport: false, submitOnEnter: false });
  expect(field.style.height).toBe("500px"); expect(field.style.overflowY).toBe("hidden");
});
it("uses three actual line heights when the message font is larger", async () => {
  const field = await render("text", { style: { boxSizing: "border-box", lineHeight: "28px", fontSize: "20px", padding: "10px 0", border: "0" } });
  expect(field.style.height).toBe("104px");
});
it("inserts a complete emoji at the selected text and respects the message length limit", async () => {
  const handleRef = createRef<ComposerHandle>(), change = vi.fn();
  const field = await render("До и после", { handleRef, onValueChange: change });
  field.setSelectionRange(3, 4);
  await act(async () => handleRef.current!.insertText("🙂"));
  expect(change).toHaveBeenCalledWith("До 🙂 после");
  await render("1234", { handleRef, onValueChange: change, maxLength: 5 });
  change.mockClear(); field.setSelectionRange(4, 4);
  await act(async () => handleRef.current!.insertText("🙂"));
  expect(change).not.toHaveBeenCalled();
});

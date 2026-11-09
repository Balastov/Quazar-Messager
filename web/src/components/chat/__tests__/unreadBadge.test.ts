import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UnreadBadge from "../UnreadBadge";
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("keeps the total count beside the mention marker", async () => {
  await act(async () => root.render(createElement(UnreadBadge, { count: 12, mentions: 2 })));
  expect(host.textContent).toBe("12@"); expect(host.firstElementChild?.getAttribute("aria-label")).toBe("Непрочитанных: 12. Упоминаний: 2");
});
it("caps only the displayed total and hides an empty badge", async () => {
  await act(async () => root.render(createElement(UnreadBadge, { count: 140, mentions: 1 })));
  expect(host.textContent).toBe("99+@");
  await act(async () => root.render(createElement(UnreadBadge, { count: 0, mentions: 0 }))); expect(host.textContent).toBe("");
});

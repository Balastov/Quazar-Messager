import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { altClickHint, useMessageMenuTrigger } from "../parts";

let host: HTMLDivElement;
let root: Root;

function Bubble({ onReply, onOpen, onLink }: { onReply?: () => void; onOpen: () => void; onLink: () => void }) {
  const trigger = useMessageMenuTrigger(() => onOpen(), onReply);
  return createElement("div", { "data-testid": "bubble", ...trigger },
    createElement("span", { "data-testid": "text" }, "Привет"),
    createElement("a", { href: "https://example.com", "data-testid": "link", onClick: (e: MouseEvent) => { e.preventDefault(); onLink(); } }, "ссылка"));
}

function click(testId: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => void host.querySelector(`[data-testid="${testId}"]`)!.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("Alt+клик по сообщению включает ответ, обычный клик — нет", () => {
  const onReply = vi.fn(), onLink = vi.fn();
  act(() => root.render(createElement(Bubble, { onReply, onOpen: vi.fn(), onLink })));
  click("text");
  expect(onReply).not.toHaveBeenCalled();
  click("text", { altKey: true });
  expect(onReply).toHaveBeenCalledOnce();
});

it("Alt+клик по ссылке внутри — тоже ответ: ссылка не открывается и не скачивается", () => {
  const onReply = vi.fn(), onLink = vi.fn();
  act(() => root.render(createElement(Bubble, { onReply, onOpen: vi.fn(), onLink })));
  const event = click("link", { altKey: true });
  expect(onReply).toHaveBeenCalledOnce();
  expect(onLink).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
  click("link");
  expect(onLink).toHaveBeenCalledOnce();
  expect(onReply).toHaveBeenCalledOnce();
});

it("где отвечать нельзя, Alt+клик ничего не делает", () => {
  const onLink = vi.fn();
  act(() => root.render(createElement(Bubble, { onOpen: vi.fn(), onLink })));
  const event = click("link", { altKey: true });
  expect(onLink).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true); // это сделала сама ссылка в тесте
});

it("подсказка в меню — по системе и только при мыши", () => {
  const media = (matches: boolean) => vi.stubGlobal("matchMedia", () => ({ matches }));
  media(true);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  expect(altClickHint()).toBe("⌥+клик");
  vi.stubGlobal("navigator", { platform: "Win32" });
  expect(altClickHint()).toBe("Alt+клик");
  media(false);
  expect(altClickHint()).toBeUndefined();
});

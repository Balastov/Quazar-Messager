import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import E2EStatusPanel from "../E2EStatusPanel";

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (trustStatus: "changed" | "unverified") => act(async () => root.render(createElement(E2EStatusPanel, {
  username: "Боб", fingerprint: "12345 67890", trustStatus, onVerify: () => {}, onAcceptKey: () => {}, onClose: () => {},
})));

it("explains a changed contact key in plain words with steps", async () => {
  await render("changed");
  const help = host.querySelector('[aria-label="Что значит смена ключа"]')!;
  expect(help.textContent).toContain("Чаще всего это безопасно");
  expect(help.textContent).toContain("Спросите собеседника голосом или лично");
  expect(help.textContent).toContain("прежняя переписка у вас по-прежнему читается");
  expect(host.textContent).toContain("Доверяю новому ключу");
});

it("does not alarm when the key simply has not been verified yet", async () => {
  await render("unverified");
  expect(host.querySelector('[aria-label="Что значит смена ключа"]')).toBeNull();
});

import {act, createElement} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
vi.mock("../../ws/socket", () => ({socket: {on: () => () => {}}}));
const {useNotifyStore} = await import("../../notifications/levels");
const {default: NotifyDialog} = await import("../NotifyDialog");
let host: HTMLDivElement, root: Root;
const save = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useNotifyStore.setState({settings: {}, save});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();});

it.each(["chat", "star", "channel"] as const)("offers all five modes for %s and persists the selected filter", async scope => {
  await act(async () => root.render(createElement(NotifyDialog, {scope, targetId: "target", title: "Уведомления", inherited: "all", onClose: vi.fn()})));
  const dialog = document.querySelector('[role="dialog"]')!;
  for (const label of ["Все сообщения", "Только упоминания", "Только ответы мне", "Упоминания и ответы мне", "Ничего"]) {
    expect(dialog.textContent).toContain(label);
  }
  const replies = [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Только ответы мне"))!;
  await act(async () => replies.click());
  expect(save).toHaveBeenCalledWith(scope, "target", {level: "replies", muted_until: null});
});

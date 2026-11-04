import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageReader } from "../../api/messages";
import type { WsEvent } from "../../api/types";

const state = vi.hoisted(() => ({ auth: { user: { id: "author" } }, handlers: new Set<(event: WsEvent) => void>(), statuses: new Set<(open: boolean) => void>() }));
vi.mock("../../store/auth", () => ({ useAuthStore: (selector: (value: typeof state.auth) => unknown) => selector(state.auth) }));
vi.mock("../../api/messages", () => ({ messagesApi: { readers: vi.fn() } }));
vi.mock("../../ws/socket", () => ({ socket: {
  on: (fn: (event: WsEvent) => void) => { state.handlers.add(fn); return () => state.handlers.delete(fn); },
  onStatus: (fn: (open: boolean) => void) => { state.statuses.add(fn); return () => state.statuses.delete(fn); },
} }));
vi.mock("../UserAvatar", () => ({ default: ({ username }: { username: string }) => createElement("span", { "aria-hidden": true }, username[0]) }));
const { messagesApi } = await import("../../api/messages");
const { default: ReadByDialog } = await import("../messages/ReadByDialog");
let host: HTMLDivElement, root: Root;
const reader = (id: string, name: string): MessageReader => ({ id, username: id, display_name: name, avatar_url: null, read_at: "2026-11-04T09:00:00Z" });
const render = async () => act(async () => root.render(createElement(ReadByDialog, { chatId: "group", messageId: "message", authorId: "author", onClose: vi.fn() })));
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); state.auth.user.id = "author"; state.handlers.clear(); state.statuses.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(messagesApi.readers).mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("loads names only for the author and sorts Cyrillic before Latin", async () => {
  vi.mocked(messagesApi.readers).mockResolvedValue([reader("z", "Zoe"), reader("b", "Борис"), reader("a", "Анна")]);
  await render();
  expect(messagesApi.readers).toHaveBeenCalledWith("group", "message");
  expect([...document.querySelectorAll("li")].map(el => el.textContent)).toEqual([
    expect.stringContaining("Анна"), expect.stringContaining("Борис"), expect.stringContaining("Zoe"),
  ]);
  expect(document.body.textContent).toContain("Прочитали: 3");
  expect(document.body.textContent).toContain("Список виден только вам");
});

it("never requests or renders the private list for another user", async () => {
  state.auth.user.id = "reader";
  await render();
  expect(messagesApi.readers).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("ignores an in-flight private response after the account changes", async () => {
  let finish!: (readers: MessageReader[]) => void;
  vi.mocked(messagesApi.readers).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render();
  state.auth.user.id = "other"; await render();
  await act(async () => finish([reader("b", "Борис")]));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Борис");
});

it("refreshes for this message's receipt and after reconnect but ignores unrelated messages", async () => {
  await render();
  await act(async () => {
    for (const handler of state.handlers) handler({ type: "message_read", chat_id: "group", message_id: "other" });
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(messagesApi.readers).toHaveBeenCalledTimes(1);
  vi.mocked(messagesApi.readers).mockResolvedValue([reader("b", "Борис")]);
  await act(async () => {
    for (const handler of state.handlers) handler({ type: "message_read", chat_id: "group", message_id: "message" });
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(document.body.textContent).toContain("Борис");
  await act(async () => { for (const handler of state.statuses) handler(true); await vi.advanceTimersByTimeAsync(150); });
  expect(messagesApi.readers).toHaveBeenCalledTimes(3);
});

it("keeps the newer list when an older request finishes late", async () => {
  let finish!: (readers: MessageReader[]) => void;
  vi.mocked(messagesApi.readers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce([reader("a", "Анна")]);
  await render();
  await act(async () => {
    for (const handler of state.handlers) handler({ type: "message_read", chat_id: "group", message_id: "message" });
    await vi.advanceTimersByTimeAsync(150);
  });
  await act(async () => finish([reader("b", "Борис")]));
  expect(document.body.textContent).toContain("Анна"); expect(document.body.textContent).not.toContain("Борис");
});

it("offers retry after an API failure without claiming that nobody has read the message", async () => {
  vi.mocked(messagesApi.readers).mockRejectedValueOnce(new Error("unavailable"));
  await render();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain("Пока нет подтверждений");
  await act(async () => [...document.querySelectorAll("button")].find(el => el.textContent === "Повторить")!.click());
  expect(document.body.textContent).toContain("Пока нет подтверждений");
  expect(document.body.textContent).toContain("Для старых сообщений");
});

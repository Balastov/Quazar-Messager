import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposerDraft } from "../useComposerDraft";
import { flushDrafts, loadDraft, useDraftsStore } from "../drafts";
let api: ReturnType<typeof useComposerDraft>, host: HTMLDivElement, root: Root;
function Editor({ user, scope, editing = false }: { user: string; scope: string; editing?: boolean }) {
  api = useComposerDraft(user, ["chat", scope], editing ? "message-to-edit" : null);
  return createElement("textarea", { value: api.text, readOnly: true });
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("indexedDB", new IDBFactory()); useDraftsStore.setState({ entries: {} }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { await flushDrafts(); root.unmount(); }); host.remove(); vi.unstubAllGlobals(); });
async function render(user: string, scope: string, editing = false) {
  await act(async () => root.render(createElement(Editor, { user, scope, editing })));
  await act(async () => { await loadDraft(api.key!, user); });
  expect(api.ready).toBe(true);
}
it("restores each conversation and never exposes another account's text", async () => {
  await render("alice", "first"); await act(async () => api.setText("Первый"));
  await render("alice", "second"); expect(api.text).toBe(""); await act(async () => api.setText("Второй"));
  await render("alice", "first"); expect(api.text).toBe("Первый");
  await render("bob", "first"); expect(api.text).toBe("");
});
it("keeps ordinary drafts separate from editing an existing message", async () => {
  await render("alice", "edit"); await act(async () => { api.setText("Мой черновик"); api.setEditText("Исправление сообщения"); });
  await render("alice", "edit", true); expect(api.text).toBe("Исправление сообщения");
  await act(async () => api.setText("Изменённый текст"));
  await render("alice", "edit"); expect(api.text).toBe("Мой черновик");
});
it("keeps the ordinary draft and newer edit text when an edit finishes later", async () => {
  await render("alice", "edit-flight");
  await act(async () => { api.setText("Обычный черновик"); api.setEditText("Первая правка"); });
  await render("alice", "edit-flight", true);
  let finish!: () => void, saving!: Promise<boolean>;
  await act(async () => { saving = api.saveEdit(() => new Promise<void>(resolve => { finish = resolve; })); });
  expect(api.sending).toBe(true);
  await act(async () => api.setText("Новая правка во время запроса"));
  let cleared: boolean | undefined;
  await act(async () => { finish(); cleared = await saving; });
  expect(cleared).toBe(false); expect(api.text).toBe("Новая правка во время запроса");
  await render("alice", "edit-flight"); expect(api.text).toBe("Обычный черновик");
});

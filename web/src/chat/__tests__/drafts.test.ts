import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
let drafts: typeof import("../drafts");
beforeEach(async () => { vi.resetModules(); vi.stubGlobal("indexedDB", new IDBFactory()); drafts = await import("../drafts"); });
afterEach(() => vi.unstubAllGlobals());
function scope(user = "alice", id = "first") { return drafts.draftKey(user, ["chat", id])!; }
function current(key: string) { return drafts.useDraftsStore.getState().entries[key]; }
async function raw(key: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("quazar-drafts"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  return new Promise<any>((resolve, reject) => {
    const transaction = database.transaction("drafts"), request = transaction.objectStore("drafts").get(key);
    transaction.oncomplete = () => { database.close(); resolve(request.result); }; transaction.onerror = () => reject(transaction.error);
  });
}
it("restores a local encrypted draft after its in-memory cache is gone", async () => {
  const key = scope(); await drafts.loadDraft(key, "alice");
  drafts.setDraft(key, "alice", "Личная переписка — секретный черновик"); await drafts.flushDrafts();
  const record = await raw(key);
  expect(record.text).toBeUndefined(); expect(record.ciphertext).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(record.ciphertext)).not.toContain("секретный черновик");
  drafts.useDraftsStore.setState({ entries: {} }); await drafts.loadDraft(key, "alice");
  expect(current(key).text).toBe("Личная переписка — секретный черновик"); expect(current(key).error).toBe(false);
});
it("isolates accounts, chats, satellites and individual threads", async () => {
  const targets = [scope(), scope("bob"), scope("alice", "second"), drafts.draftKey("alice", ["star", "s", "c"])!, drafts.draftKey("alice", ["thread", "s", "c", "root"])!];
  for (const [index, key] of targets.entries()) drafts.setDraft(key, index === 1 ? "bob" : "alice", "draft-" + index);
  await drafts.flushDrafts(); drafts.useDraftsStore.setState({ entries: {} });
  for (const [index, key] of targets.entries()) { await drafts.loadDraft(key, index === 1 ? "bob" : "alice"); expect(current(key).text).toBe("draft-" + index); }
});
it("retains failed sends and clears only an unchanged successfully accepted draft", async () => {
  const key = scope(); drafts.setDraft(key, "alice", "Не потерять");
  await expect(drafts.sendDraft(key, "alice", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(current(key).text).toBe("Не потерять"); expect(current(key).sending).toBe(false);
  await drafts.sendDraft(key, "alice", async () => {}); await drafts.flushDrafts();
  expect(current(key).text).toBe(""); expect(await raw(key)).toBeUndefined();
});
it("does not erase typing started while a send is in flight and prevents duplicate sends", async () => {
  const key = scope(); drafts.setDraft(key, "alice", "Первое");
  let finish!: () => void;
  const sending = drafts.sendDraft(key, "alice", () => new Promise<void>(resolve => { finish = resolve; }));
  const duplicate = vi.fn(); expect(await drafts.sendDraft(key, "alice", duplicate)).toBe(false); expect(duplicate).not.toHaveBeenCalled();
  drafts.setDraft(key, "alice", "Новый текст"); finish(); await sending; await drafts.flushDrafts();
  expect(current(key).text).toBe("Новый текст");
});
it("serializes rapid changes so the final text survives reload", async () => {
  const key = scope(); for (const value of ["a", "ab", "abc", "Последний"]) drafts.setDraft(key, "alice", value);
  await drafts.flushDrafts(); drafts.useDraftsStore.setState({ entries: {} }); await drafts.loadDraft(key, "alice");
  expect(current(key).text).toBe("Последний");
});
it("keeps an in-memory draft and reports when persistent storage is blocked", async () => {
  vi.stubGlobal("indexedDB", { open: () => { throw new Error("blocked"); } });
  const key = scope(); await drafts.loadDraft(key, "alice"); drafts.setDraft(key, "alice", "Текст остаётся"); await drafts.flushDrafts();
  expect(current(key).text).toBe("Текст остаётся"); expect(current(key).ready).toBe(true); expect(current(key).error).toBe(true);
});
it("forgets one account's drafts and their key without touching another account", async () => {
  const mine = scope(), theirs = scope("bob");
  await drafts.loadDraft(mine, "alice"); await drafts.loadDraft(theirs, "bob");
  drafts.setDraft(mine, "alice", "черновик Алисы"); drafts.setDraft(theirs, "bob", "черновик Боба"); await drafts.flushDrafts();
  await drafts.forgetDrafts("alice");
  expect(await raw(mine)).toBeUndefined();
  expect(current(mine)).toBeUndefined();
  drafts.useDraftsStore.setState({ entries: {} });
  await drafts.loadDraft(theirs, "bob");
  expect(current(theirs).text).toBe("черновик Боба");
});

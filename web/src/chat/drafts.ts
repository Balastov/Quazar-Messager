import { create } from "zustand";

export interface DraftEntry { text: string; ready: boolean; error: boolean; revision: number; sending: boolean }
export const EMPTY: DraftEntry = { text: "", ready: false, error: false, revision: 0, sending: false };
export const NO_DRAFT: DraftEntry = { ...EMPTY, ready: true };
interface StoredDraft { key: string; iv: Uint8Array; ciphertext: ArrayBuffer }
let database: Promise<IDBDatabase> | null = null;
const keys = new Map<string, Promise<CryptoKey>>();
const loads = new Map<string, Promise<void>>();
const writes = new Map<string, Promise<void>>();

function db(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("quazar-drafts", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("drafts", { keyPath: "key" }); request.result.createObjectStore("keys"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Draft storage is blocked"));
  }).catch(error => { database = null; throw error; });
  return database;
}
async function read<T>(store: string, key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, "readonly"), request = transaction.objectStore(store).get(key);
    transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error);
  });
}
function accountKey(userId: string): Promise<CryptoKey> {
  let pending = keys.get(userId);
  if (!pending) {
    pending = (async () => {
      const previous = await read<CryptoKey>("keys", userId);
      if (previous) return previous;
      const generated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const database = await db();
      // Re-read inside the transaction: another tab may have generated its key too.
      return new Promise<CryptoKey>((resolve, reject) => {
        const transaction = database.transaction("keys", "readwrite"), store = transaction.objectStore("keys"), request = store.get(userId);
        let selected = generated;
        request.onsuccess = () => { if (request.result) selected = request.result; else store.put(generated, userId); };
        transaction.oncomplete = () => resolve(selected); transaction.onerror = () => reject(transaction.error);
      });
    })().catch(error => { keys.delete(userId); throw error; });
    keys.set(userId, pending);
  }
  return pending;
}

async function persist(key: string, userId: string, text: string): Promise<void> {
  let record: StoredDraft | null = null;
  if (text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(text);
    try {
      record = { key, iv, ciphertext: await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(key) }, await accountKey(userId), plaintext) };
    } finally { plaintext.fill(0); }
  }
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("drafts", "readwrite"), store = transaction.objectStore("drafts");
    if (record) store.put(record); else store.delete(key);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function draftKey(userId: string | undefined, target: readonly string[] | null): string | null {
  return userId && target?.every(Boolean) ? JSON.stringify([userId, ...target]) : null;
}
export const useDraftsStore = create<{ entries: Record<string, DraftEntry> }>(() => ({ entries: {} }));
const entry = (key: string) => useDraftsStore.getState().entries[key] ?? EMPTY;
function update(key: string, patch: Partial<DraftEntry>) {
  useDraftsStore.setState(state => ({ entries: { ...state.entries, [key]: { ...(state.entries[key] ?? EMPTY), ...patch } } }));
}
export async function loadDraft(key: string, userId: string): Promise<void> {
  if (entry(key).ready) return;
  let pending = loads.get(key);
  if (!pending) {
    const revision = entry(key).revision;
    pending = (async () => {
      try {
        const record = await read<StoredDraft>("drafts", key);
        let text = "";
        if (record) {
          const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv as BufferSource, additionalData: new TextEncoder().encode(key) }, await accountKey(userId), record.ciphertext);
          const bytes = new Uint8Array(plaintext);
          try { text = new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
        } else await accountKey(userId);
        if (entry(key).revision === revision) update(key, { text, ready: true, error: false });
      } catch { if (entry(key).revision === revision) update(key, { ready: true, error: true }); }
      finally { loads.delete(key); }
    })();
    loads.set(key, pending);
  }
  return pending;
}
export function setDraft(key: string, userId: string, value: string | ((previous: string) => string)) {
  const previous = entry(key), text = typeof value === "function" ? value(previous.text) : value;
  if (previous.ready && text === previous.text) return;
  const revision = previous.revision + 1;
  update(key, { text, revision, ready: true });
  const writing = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => entry(key).revision === revision ? persist(key, userId, text) : undefined)
    .then(() => { if (entry(key).revision === revision) update(key, { error: false }); })
    .catch(() => { if (entry(key).revision === revision) update(key, { error: true }); });
  writes.set(key, writing);
  void writing.finally(() => { if (writes.get(key) === writing) writes.delete(key); });
}

/** Keep a draft until the server accepts it; never erase text changed while sending. */
export async function sendDraft(key: string, userId: string, action: () => Promise<void>, clear = true): Promise<boolean> {
  const current = entry(key);
  if (!current.ready || current.sending) return false;
  const revision = current.revision;
  update(key, { sending: true });
  try {
    await action();
    if (!clear) return true;
    if (entry(key).revision !== revision) return false;
    setDraft(key, userId, "");
    return true;
  } finally { update(key, { sending: false }); }
}

/** Tests and orderly shutdown can wait for writes already started by keystrokes. */
export async function flushDrafts() { await Promise.all([...writes.values()]); }

/** Стирает черновики аккаунта и ключ, которым они зашифрованы, с этого устройства. */
export async function forgetDrafts(userId: string): Promise<void> {
  await Promise.allSettled([...writes.values()]);
  const prefix = JSON.stringify([userId]).slice(0, -1) + ",";
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(["drafts", "keys"], "readwrite"), drafts = transaction.objectStore("drafts");
    transaction.objectStore("keys").delete(userId);
    const request = drafts.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  keys.delete(userId);
  useDraftsStore.setState(state => ({ entries: Object.fromEntries(Object.entries(state.entries).filter(([key]) => !key.startsWith(prefix))) }));
}

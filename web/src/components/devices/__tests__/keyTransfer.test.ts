import { IDBFactory } from "fake-indexeddb";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PairView, ReceiverRequest } from "../../../api/devices";

const e2e = vi.hoisted(() => ({
  status: "needs_restore", hasServerBackup: true, hasLocalKey: false, accountPublicKey: "", localPublicKey: null,
  restorePromptOpen: true, busy: false, userId: "alice", sync: vi.fn(), setRestorePromptOpen: vi.fn(),
  restoreFromServer: vi.fn(), restoreFromFile: vi.fn(), rotate: vi.fn(), adoptBackup: vi.fn(),
}));
vi.mock("../../../store/e2e", () => ({
  useE2EStore: Object.assign((selector: (value: typeof e2e) => unknown) => selector(e2e), { getState: () => e2e }),
}));
const auth = vi.hoisted(() => ({ user: { id: "alice", has_password: false, phone_verified_at: null } }));
vi.mock("../../../store/auth", () => ({
  useAuthStore: Object.assign((selector: (value: typeof auth) => unknown) => selector(auth), { getState: () => auth }),
}));
const ws = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock("../../../ws/socket", () => ({ socket: { on: (handler: (event: unknown) => void) => { ws.handlers.add(handler); return () => ws.handlers.delete(handler); } } }));
vi.mock("../../../api/devices", () => ({ devicesApi: { requestKeys: vi.fn(), status: vi.fn(), consumeKeys: vi.fn(), cancel: vi.fn(), claim: vi.fn(), approve: vi.fn(), reject: vi.fn() } }));
const { devicesApi } = await import("../../../api/devices");
const { pairBinding, pairKeys } = await import("../../../crypto/deviceTransfer");
const { derivePublicKeyFromSeed, loadIdentityKeyPair } = await import("../../../crypto/webcrypto");
const { default: DeviceKeyReceiver } = await import("../DeviceKeyReceiver");
const { default: E2EKeyGate } = await import("../../E2EKeyGate");

const id = "12345678-1234-4321-8123-123456789abc";
const account = { id: "alice", username: "alice", display_name: "Алиса", avatar_url: null };
const seed = nacl.randomBytes(32), accountKey = derivePublicKeyFromSeed(seed);
const approver = pairKeys();
let host: HTMLDivElement, root: Root, latest: PairView;

const realTimeout = globalThis.setTimeout;
const settle = async (ms = 2000) => {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
  // WebCrypto и IndexedDB идут вне фейковых таймеров.
  for (let i = 0; i < 10; i++) await act(() => new Promise<void>(done => realTimeout(done, 5)));
};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text);

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // fake-indexeddb работает через setImmediate — его не подменяем.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("indexedDB", new IDBFactory());
  e2e.accountPublicKey = accountKey; e2e.status = "needs_restore";
  vi.mocked(devicesApi.requestKeys).mockImplementation(async (body: ReceiverRequest) => ({
    request: latest = { id, kind: "keys", state: "pending", receiver_public_key: body.public_key, approver_public_key: null,
      account: null, account_public_key: null, device_name: body.device_name, transferred_keys: false,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() },
    code: "ABCDEFGH",
  }));
  vi.mocked(devicesApi.status).mockImplementation(async () => latest);
  vi.mocked(devicesApi.cancel).mockResolvedValue({} as never);
  vi.mocked(devicesApi.reject).mockResolvedValue({} as never);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); await settle(0); host.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

/** Так пакет собирает подтверждающее устройство (см. sealDeviceKeys). */
async function sealed(flow: PairView) {
  const nonce = nacl.randomBytes(24);
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, request_id: flow.id, user_id: account.id,
    binding: await pairBinding(flow), public_key: accountKey, seed: encodeBase64(seed), archived: [] }));
  return { nonce: encodeBase64(nonce), ciphertext: encodeBase64(nacl.box(plaintext, nonce, decodeBase64(flow.receiver_public_key!), approver.secretKey)) };
}

it("receives the account key on a signed-in device without logging out", async () => {
  const done = vi.fn();
  await act(async () => root.render(createElement(DeviceKeyReceiver, { userId: "alice", onDone: done })));
  await settle(0);
  expect(host.textContent).toContain("ABCD-EFGH");
  expect(host.querySelector('[aria-label="QR-код подключения"]')).not.toBeNull();

  latest = { ...latest, state: "claimed", account, account_public_key: accountKey, approver_public_key: approver.publicKey };
  await settle();
  expect(host.textContent).toContain("Ждём подтверждение");
  expect(host.querySelector('[aria-label="Код сравнения"]')?.textContent).toMatch(/[0-9A-F]{4}/);

  const approved = { ...latest, state: "approved" as const, transferred_keys: true };
  vi.mocked(devicesApi.consumeKeys).mockImplementation(async () => ({ request: { ...approved, state: "consumed" }, encrypted_keys: await sealed(approved) }));
  latest = approved;
  await settle();
  expect(devicesApi.consumeKeys).toHaveBeenCalledOnce();
  expect((await loadIdentityKeyPair())?.publicKey).toBe(accountKey);
  expect(e2e.sync).toHaveBeenCalledWith("alice");
  expect(done).toHaveBeenCalledOnce();
  expect(devicesApi.cancel).not.toHaveBeenCalled();
});

it("does not store keys that belong to another account", async () => {
  await act(async () => root.render(createElement(DeviceKeyReceiver, { userId: "alice" })));
  await settle(0);
  const approved = { ...latest, state: "approved" as const, account: { ...account, id: "mallory" }, account_public_key: accountKey, approver_public_key: approver.publicKey, transferred_keys: true };
  vi.mocked(devicesApi.consumeKeys).mockImplementation(async () => ({ request: { ...approved, state: "consumed" }, encrypted_keys: await sealed(approved) }));
  latest = approved;
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("другому аккаунту");
  expect(await loadIdentityKeyPair()).toBeNull();
  expect(e2e.sync).not.toHaveBeenCalled();
});

it("leads the restore dialog with device transfer and explains the backup password", async () => {
  await act(async () => root.render(createElement(E2EKeyGate)));
  expect(host.textContent).toContain("Это не пароль от аккаунта и не код из звонка");
  expect(host.querySelector("details summary")?.textContent).toBe("Не помню пароль копии");
  const start = button("Получить ключи с другого устройства")!;
  const buttons = [...host.querySelectorAll("button")];
  expect(buttons.indexOf(start)).toBeLessThan(buttons.indexOf(button("Восстановить")!));
  await act(async () => Simulate.click(start));
  await settle(0);
  expect(devicesApi.requestKeys).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("ABCD-EFGH");
});

it("offers to pass keys when another own device asks for them", async () => {
  e2e.status = "ready";
  vi.mocked(devicesApi.claim).mockImplementation(async body => ({ ...latest, state: "claimed", account, account_public_key: accountKey, approver_public_key: body.public_key }));
  await act(async () => root.render(createElement(E2EKeyGate)));
  const receiverKey = pairKeys().publicKey;
  latest = { id, kind: "keys", state: "pending", receiver_public_key: receiverKey, approver_public_key: null, account: null,
    account_public_key: null, device_name: "Quazar Desktop · Windows", transferred_keys: false,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() };
  await act(async () => ws.handlers.forEach(handler => handler({ type: "device_key_request", id, receiver_public_key: receiverKey,
    device_name: "Quazar Desktop · Windows", expires_at: latest.expires_at })));
  expect(host.textContent).toContain("«Quazar Desktop · Windows» просит ключи шифрования");
  // Запрос не занимается, пока пользователь не согласился.
  expect(devicesApi.claim).not.toHaveBeenCalled();
  await act(async () => Simulate.click(button("Передать ключи")!));
  await settle(0);
  expect(devicesApi.claim).toHaveBeenCalledWith({ public_key: expect.any(String), request_id: id, expected_key: receiverKey });
  expect(document.body.textContent).toContain("Ключи переписки просит");

  // Своё подтверждение не закрывается, когда сервер сообщает, что запрос занят (этим же устройством).
  await act(async () => ws.handlers.forEach(handler => handler({ type: "device_key_request_closed", id })));
  expect(document.body.textContent).toContain("Ключи переписки просит");
  // Закрыли подтверждение, не передав ключи, — запрос отклоняется.
  await act(async () => root.render(null)); await settle(0);
  expect(devicesApi.reject).toHaveBeenCalledWith(id);
});

it("hides a request that another device took or the requester cancelled", async () => {
  e2e.status = "ready";
  await act(async () => root.render(createElement(E2EKeyGate)));
  const expires = new Date(Date.now() + 300_000).toISOString();
  await act(async () => ws.handlers.forEach(handler => handler({ type: "device_key_request", id, receiver_public_key: pairKeys().publicKey, device_name: "Ноутбук", expires_at: expires })));
  expect(host.textContent).toContain("«Ноутбук» просит ключи");
  await act(async () => ws.handlers.forEach(handler => handler({ type: "device_key_request_closed", id: "другой" })));
  expect(host.textContent).toContain("«Ноутбук» просит ключи");
  await act(async () => ws.handlers.forEach(handler => handler({ type: "device_key_request_closed", id })));
  expect(host.textContent).not.toContain("просит ключи");
  expect(devicesApi.claim).not.toHaveBeenCalled();
});

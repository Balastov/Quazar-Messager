import { IDBFactory } from "fake-indexeddb";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession, PairView, ReceiverRequest } from "../../../api/devices";

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
vi.mock("../../../ws/socket", () => ({ socket: { on: (handler: (event: unknown) => void) => { ws.handlers.add(handler); return () => ws.handlers.delete(handler); }, onStatus: () => () => {} } }));
vi.mock("../../../api/devices", () => ({ devicesApi: {
  requestKeys: vi.fn(), status: vi.fn(), consumeKeys: vi.fn(), cancel: vi.fn(), claim: vi.fn(), approve: vi.fn(), reject: vi.fn(),
  list: vi.fn(), pendingKeyRequests: vi.fn(), approverNonce: vi.fn(), owned: vi.fn(), reveal: vi.fn(), deny: vi.fn(),
} }));
const { devicesApi } = await import("../../../api/devices");
const { pairBinding, pairKeys } = await import("../../../crypto/deviceTransfer");
const { commitNonce, keyNumber, randomNonce } = await import("../../../crypto/keyNumber");
const { derivePublicKeyFromSeed, importDeviceIdentities, loadIdentityKeyPair } = await import("../../../crypto/webcrypto");
const { default: DeviceKeyReceiver, DONE_PAUSE_MS } = await import("../DeviceKeyReceiver");
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
const emit = (event: unknown) => act(async () => ws.handlers.forEach(handler => handler(event)));
const device = (name: string, has_account_key: boolean | null, current = false): DeviceSession => ({ id: name, name, current, has_account_key,
  created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString() });

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // fake-indexeddb работает через setImmediate — его не подменяем.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("indexedDB", new IDBFactory());
  e2e.accountPublicKey = accountKey; e2e.status = "needs_restore"; e2e.hasServerBackup = true;
  vi.mocked(devicesApi.requestKeys).mockImplementation(async (body: ReceiverRequest & { commitment?: string }) => ({
    request: latest = { id, kind: "keys", state: "pending", receiver_public_key: body.public_key, approver_public_key: null,
      account: null, account_public_key: null, device_name: body.device_name, transferred_keys: false, commitment: body.commitment,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() },
    code: "ABCDEFGH",
  }));
  vi.mocked(devicesApi.status).mockImplementation(async () => latest);
  vi.mocked(devicesApi.reveal).mockImplementation(async (_id, _secret, nonce) => (latest = { ...latest, receiver_nonce: nonce }));
  vi.mocked(devicesApi.cancel).mockResolvedValue({} as never);
  vi.mocked(devicesApi.reject).mockResolvedValue({} as never);
  vi.mocked(devicesApi.deny).mockResolvedValue({} as never);
  vi.mocked(devicesApi.list).mockResolvedValue([device("Этот", false, true), device("iPhone · Quazar", true)]);
  vi.mocked(devicesApi.pendingKeyRequests).mockResolvedValue([]);
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

it("asks another device without codes, shows the shared number and opens the chats", async () => {
  const done = vi.fn();
  await act(async () => root.render(createElement(DeviceKeyReceiver, { userId: "alice", onDone: done })));
  await settle(0);
  // Запрос ушёл сам и несёт только хэш числа; ни QR, ни кода больше нет.
  expect(devicesApi.requestKeys).toHaveBeenCalledWith(expect.objectContaining({ commitment: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  expect(host.textContent).toContain("Ждём ответа");
  expect(host.querySelector('[aria-label="QR-код подключения"]')).toBeNull();
  // Раскрывать число до ответа другого устройства нельзя.
  latest = { ...latest, state: "claimed", account, account_public_key: accountKey, approver_public_key: approver.publicKey };
  await settle();
  expect(devicesApi.reveal).not.toHaveBeenCalled();

  latest = { ...latest, approver_nonce: randomNonce() };
  await emit({ type: "device_key_request_changed", id });
  await settle(0);
  expect(devicesApi.reveal).toHaveBeenCalledOnce();
  const revealed = vi.mocked(devicesApi.reveal).mock.calls[0][2];
  expect(await commitNonce(latest.receiver_public_key!, revealed)).toBe(latest.commitment);
  const shown = host.querySelector('[aria-label="Число для подтверждения"]')?.textContent;
  expect(shown).toBe(String(await keyNumber(latest)));
  expect(host.textContent).toContain("Нажмите это число на другом устройстве");

  const approved = { ...latest, state: "approved" as const, transferred_keys: true };
  vi.mocked(devicesApi.consumeKeys).mockImplementation(async () => ({ request: { ...approved, state: "consumed" }, encrypted_keys: await sealed(approved) }));
  latest = approved;
  await settle();
  expect(devicesApi.consumeKeys).toHaveBeenCalledOnce();
  expect((await loadIdentityKeyPair())?.publicKey).toBe(accountKey);
  expect(host.textContent).toContain("Готово, переписка открыта");
  await settle(DONE_PAUSE_MS);
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

it("offers to try again when the other device cancelled", async () => {
  await act(async () => root.render(createElement(DeviceKeyReceiver, { userId: "alice" })));
  await settle(0);
  latest = { ...latest, state: "rejected" };
  await settle();
  expect(host.textContent).toContain("Запрос отменён на другом устройстве");
  await act(async () => Simulate.click(button("Отправить запрос снова")!));
  await settle(0);
  expect(devicesApi.requestKeys).toHaveBeenCalledTimes(2);
});

it("opens with the device route, then the recovery password, then a fresh start", async () => {
  await act(async () => root.render(createElement(E2EKeyGate)));
  await settle(0);
  expect(host.textContent).toContain("Откройте переписку на этом устройстве");
  expect(host.textContent).toContain("iPhone · Quazar");
  expect(devicesApi.requestKeys).toHaveBeenCalledOnce();
  await act(async () => Simulate.click(button("Нет доступа к другим устройствам")!));
  expect(host.textContent).toContain("Введите пароль для восстановления");
  expect(host.textContent).toContain("Это не пароль от аккаунта и не код из звонка");
  await act(async () => Simulate.click(button("Не помню пароль")!));
  expect(host.textContent).toContain("Начать переписку заново");
  expect(host.textContent).toContain("собеседники увидят пометку «ключ шифрования изменился»");
  expect(host.textContent).toContain("На остальных ваших устройствах переписку нужно будет открыть заново");
  await act(async () => Simulate.click(button("Назад")!));
  expect(host.textContent).toContain("Откройте переписку на этом устройстве");
});

it("skips the device route when no other device has the key", async () => {
  vi.mocked(devicesApi.list).mockResolvedValue([device("Этот", false, true), device("Ноутбук", false)]);
  e2e.hasServerBackup = false;
  await act(async () => root.render(createElement(E2EKeyGate)));
  await settle(0);
  expect(host.textContent).toContain("Начать переписку заново");
  expect(devicesApi.requestKeys).not.toHaveBeenCalled();
  await act(async () => Simulate.click(button("Есть файл копии")!));
  expect(host.textContent).toContain("понадобится файл копии");
});

describe("on the device that can read the chats", () => {
  let receiverNonce: string, request: { type: "device_key_request"; id: string; receiver_public_key: string; device_name: string; expires_at: string; commitment: string; created_at: string };

  beforeEach(async () => {
    e2e.status = "ready";
    await importDeviceIdentities("alice", seed, []);
    const receiverKey = pairKeys().publicKey;
    receiverNonce = randomNonce();
    const commitment = await commitNonce(receiverKey, receiverNonce);
    latest = { id, kind: "keys", state: "pending", receiver_public_key: receiverKey, approver_public_key: null, account: null,
      account_public_key: null, device_name: "Chrome · Windows", transferred_keys: false, commitment,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() };
    request = { type: "device_key_request", id, receiver_public_key: receiverKey, device_name: "Chrome · Windows",
      expires_at: latest.expires_at, commitment, created_at: latest.created_at };
    vi.mocked(devicesApi.claim).mockImplementation(async body => (latest = { ...latest, state: "claimed", account, account_public_key: accountKey, approver_public_key: body.public_key }));
    vi.mocked(devicesApi.approverNonce).mockImplementation(async (_id, nonce) => (latest = { ...latest, approver_nonce: nonce }));
    // Новое устройство раскрывает своё число, как только видит число этого.
    vi.mocked(devicesApi.owned).mockImplementation(async () => (latest = { ...latest, receiver_nonce: latest.approver_nonce ? receiverNonce : null }));
    vi.mocked(devicesApi.approve).mockImplementation(async () => (latest = { ...latest, state: "approved", transferred_keys: true }));
  });

  const answerYes = async () => {
    await act(async () => root.render(createElement(E2EKeyGate)));
    await emit(request);
    expect(document.body.textContent).toContain("Это вы входите?");
    expect(document.body.textContent).toContain("Chrome · Windows");
    // Запрос не занимается, пока пользователь не ответил.
    expect(devicesApi.claim).not.toHaveBeenCalled();
    await act(async () => Simulate.click(button("Да, это я")!));
    await settle();
    expect(devicesApi.claim).toHaveBeenCalledWith({ public_key: expect.any(String), request_id: id, expected_key: request.receiver_public_key });
    expect(devicesApi.approverNonce).toHaveBeenCalledOnce();
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Число с нового устройства"] button')].map(node => Number(node.textContent));
    expect(new Set(choices).size).toBe(3);
    const correct = await keyNumber(latest);
    expect(choices).toContain(correct);
    return { correct, choices };
  };

  it("passes the chats after tapping the number shown on the new device", async () => {
    const { correct } = await answerYes();
    await act(async () => Simulate.click(button(String(correct))!));
    await settle(0);
    expect(devicesApi.approve).toHaveBeenCalledWith(id, await pairBinding(latest), expect.objectContaining({ nonce: expect.any(String) }), false);
    expect(document.body.textContent).toContain("Готово. На «Chrome · Windows» переписка откроется");
    expect(devicesApi.reject).not.toHaveBeenCalled();
  });

  it("cancels the request when a wrong number is tapped", async () => {
    const { correct, choices } = await answerYes();
    await act(async () => Simulate.click(button(String(choices.find(value => value !== correct)))!));
    await settle(0);
    expect(devicesApi.approve).not.toHaveBeenCalled();
    expect(devicesApi.reject).toHaveBeenCalledWith(id);
    expect(document.body.textContent).toContain("Число не совпало, запрос отменён");
  });

  it("signs the other device out on «Это не я»", async () => {
    // Сервер рассылает «запрос закрыт» раньше, чем отвечает: пояснение всё равно остаётся на экране.
    vi.mocked(devicesApi.deny).mockImplementation(async () => {
      ws.handlers.forEach(handler => handler({ type: "device_key_request_closed", id }));
      return {} as never;
    });
    await act(async () => root.render(createElement(E2EKeyGate)));
    await emit(request);
    await act(async () => Simulate.click(button("Это не я")!));
    await settle(0);
    expect(devicesApi.deny).toHaveBeenCalledWith(id);
    expect(devicesApi.claim).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Мы завершили вход на «Chrome · Windows»");
  });

  it("refuses to show numbers when the revealed number does not match the commitment", async () => {
    vi.mocked(devicesApi.owned).mockImplementation(async () => (latest = { ...latest, receiver_nonce: randomNonce() }));
    await act(async () => root.render(createElement(E2EKeyGate)));
    await emit(request);
    await act(async () => Simulate.click(button("Да, это я")!));
    await settle();
    expect(document.querySelector('[aria-label="Число с нового устройства"]')).toBeNull();
    expect(document.body.textContent).toContain("Запрос изменился по дороге");
  });

  it("picks up a request missed while the app was closed", async () => {
    vi.mocked(devicesApi.pendingKeyRequests).mockResolvedValue([request]);
    await act(async () => root.render(createElement(E2EKeyGate)));
    await settle(0);
    expect(document.body.textContent).toContain("Это вы входите?");
  });

  it("hides a request that another device took or the requester cancelled", async () => {
    await act(async () => root.render(createElement(E2EKeyGate)));
    await emit(request);
    await emit({ type: "device_key_request_closed", id: "другой" });
    expect(document.body.textContent).toContain("Это вы входите?");
    await emit({ type: "device_key_request_closed", id });
    expect(document.body.textContent).not.toContain("Это вы входите?");
    expect(devicesApi.claim).not.toHaveBeenCalled();
  });
});

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PairView } from "../../../api/devices";
import { pairKeys } from "../../../crypto/deviceTransfer";
import type { ReceiverRequest } from "../../../api/devices";

const state = vi.hoisted(() => ({ token: null as string | null, user: { id: "alice", username: "alice", display_name: "Алиса" }, logout: vi.fn() }));
vi.mock("../../../store/auth", () => ({ useAuthStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }));
vi.mock("../../../api/devices", () => ({ devicesApi: { create: vi.fn(), status: vi.fn(), consume: vi.fn(), cancel: vi.fn(), discard: vi.fn(), claim: vi.fn(), approve: vi.fn(), reject: vi.fn(), invite: vi.fn(), owned: vi.fn(), accept: vi.fn() } }));
vi.mock("../../../crypto/deviceTransfer", async original => ({ ...await original<typeof import("../../../crypto/deviceTransfer")>(), inspectTransfer: vi.fn(), sealDeviceKeys: vi.fn() }));
vi.mock("../../../auth/deviceLink", async original => ({ ...await original<typeof import("../../../auth/deviceLink")>(), finishDeviceLogin: vi.fn() }));
const { devicesApi } = await import("../../../api/devices");
const { inspectTransfer, sealDeviceKeys } = await import("../../../crypto/deviceTransfer");
const { finishDeviceLogin, deviceLink } = await import("../../../auth/deviceLink");
const { default: DeviceReceiver } = await import("../DeviceReceiver");
const { DeviceAuthorizer, DeviceInvitation } = await import("../DeviceAuthorizer");
const { default: DeviceConnectPage } = await import("../../../pages/DeviceConnectPage");

let host: HTMLDivElement, root: Root, latest: PairView;
const id = "12345678-1234-4321-8123-123456789abc";
const account = { id: "alice", username: "alice", display_name: "Алиса", avatar_url: null };
const provider = pairKeys(), receiver = pairKeys();
const base = (): PairView => ({ id, kind: "request", state: "pending", receiver_public_key: receiver.publicKey,
  approver_public_key: null, account: null, account_public_key: null, device_name: "Телефон", transferred_keys: false,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120_000).toISOString() });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text)!;
const tick = (ms = 2000) => act(async () => vi.advanceTimersByTimeAsync(ms));
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.token = null; latest = base();
  window.history.replaceState(null, "", "/auth");
  vi.mocked(devicesApi.create).mockImplementation(async (body: ReceiverRequest) => ({ request: latest = { ...base(), receiver_public_key: body.public_key, device_name: body.device_name }, code: "ABCDEFGH" }));
  vi.mocked(devicesApi.status).mockImplementation(async () => latest);
  vi.mocked(devicesApi.cancel).mockResolvedValue({} as never); vi.mocked(devicesApi.reject).mockResolvedValue({} as never);
  vi.mocked(devicesApi.discard).mockResolvedValue({} as never);
  vi.mocked(finishDeviceLogin).mockResolvedValue(undefined);
  vi.mocked(inspectTransfer).mockResolvedValue({ available: true, needsKeys: false, skippedArchives: 0 });
  vi.mocked(sealDeviceKeys).mockResolvedValue(null);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); await tick(0); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("starts once in StrictMode and waits for source approval plus the receiving user's confirmation", async () => {
  const done = vi.fn();
  await act(async () => root.render(createElement(StrictMode, null, createElement(DeviceReceiver, { onDone: done }))));
  await tick(0);
  expect(devicesApi.create).toHaveBeenCalledOnce();
  expect(devicesApi.cancel).not.toHaveBeenCalled();
  expect(host.textContent).toContain("ABCD-EFGH");
  latest = { ...latest, state: "approved", account, approver_public_key: provider.publicKey };
  await tick();
  expect(button("Войти как Алиса")).toBeDefined();
  expect(devicesApi.consume).not.toHaveBeenCalled();
  vi.mocked(devicesApi.consume).mockResolvedValue({ request: { ...latest, state: "consumed" }, access_token: "new-session", encrypted_keys: null });
  await act(async () => button("Войти как Алиса").click());
  expect(finishDeviceLogin).toHaveBeenCalledOnce();
  const keys = vi.mocked(finishDeviceLogin).mock.calls[0][1];
  expect(keys.secretKey.some(value => value !== 0)).toBe(true);
  expect(done).toHaveBeenCalledOnce();
});

it("cancels a pending request when the receiver leaves", async () => {
  await act(async () => root.render(createElement(DeviceReceiver, { onDone: vi.fn() })));
  const secret = vi.mocked(devicesApi.create).mock.calls[0][0].receiver_secret;
  await act(async () => root.render(null)); await tick(0);
  expect(devicesApi.cancel).toHaveBeenCalledWith(id, secret);
  expect(devicesApi.consume).not.toHaveBeenCalled();
});

it("does not accept key changes after the receiving code has been shown", async () => {
  await act(async () => root.render(createElement(DeviceReceiver, { onDone: vi.fn() })));
  latest = { ...latest, state: "claimed", account, approver_public_key: provider.publicKey };
  await tick();
  latest = { ...latest, approver_public_key: pairKeys().publicKey };
  await tick();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("изменились");
  expect(devicesApi.consume).not.toHaveBeenCalled();
});

it("requires the matching-code checkbox before authorizing a code request", async () => {
  state.token = "trusted-session";
  vi.mocked(devicesApi.claim).mockImplementation(async body => latest = { ...base(), state: "claimed", account,
    approver_public_key: body.public_key, receiver_public_key: receiver.publicKey });
  vi.mocked(devicesApi.approve).mockImplementation(async () => ({ ...latest, state: "approved" }));
  await act(async () => root.render(createElement(DeviceAuthorizer)));
  const input = host.querySelector<HTMLInputElement>('[aria-label="Одноразовый код"]')!;
  await act(async () => { input.value = "ABCD-EFGH"; Simulate.change(input); });
  await act(async () => Simulate.submit(host.querySelector("form")!));
  await tick(0);
  const approve = button("Это моё устройство — разрешить вход");
  expect(approve.disabled).toBe(true);
  expect(devicesApi.approve).not.toHaveBeenCalled();
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => { checkbox.checked = true; Simulate.change(checkbox); });
  await act(async () => approve.click());
  expect(devicesApi.approve).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Подключение разрешено");
});

it("requires explicit consent when the source cannot transfer chat keys", async () => {
  state.token = "trusted-session";
  vi.mocked(inspectTransfer).mockResolvedValue({ available: false, needsKeys: true, skippedArchives: 0 });
  vi.mocked(devicesApi.claim).mockImplementation(async body => latest = { ...base(), state: "claimed", account,
    account_public_key: pairKeys().publicKey, approver_public_key: body.public_key });
  vi.mocked(devicesApi.approve).mockImplementation(async () => ({ ...latest, state: "approved" }));
  await act(async () => root.render(createElement(DeviceAuthorizer)));
  const input = host.querySelector<HTMLInputElement>('[aria-label="Одноразовый код"]')!;
  await act(async () => { input.value = "ABCDEFGH"; Simulate.change(input); });
  await act(async () => Simulate.submit(host.querySelector("form")!)); await tick(0);
  const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => { boxes[0].checked = true; Simulate.change(boxes[0]); });
  expect(button("Это моё устройство — разрешить вход").disabled).toBe(true);
  await act(async () => { boxes[1].checked = true; Simulate.change(boxes[1]); });
  await act(async () => button("Это моё устройство — разрешить вход").click());
  expect(devicesApi.approve).toHaveBeenCalledWith(id, expect.stringMatching(/^[a-f0-9]{64}$/), null, true);
  expect(sealDeviceKeys).not.toHaveBeenCalled();
});

it("keeps an approved phone invitation usable after closing the source dialog", async () => {
  state.token = "trusted-session";
  vi.mocked(devicesApi.invite).mockImplementation(async public_key => ({ request: latest = { ...base(), kind: "invite", state: "offered", receiver_public_key: null, approver_public_key: public_key, account }, invite_secret: "i".repeat(43) }));
  vi.mocked(devicesApi.owned).mockImplementation(async () => latest = { ...latest, state: "claimed", receiver_public_key: receiver.publicKey });
  vi.mocked(devicesApi.approve).mockImplementation(async () => ({ ...latest, state: "approved" }));
  await act(async () => root.render(createElement(StrictMode, null, createElement(DeviceInvitation))));
  expect(host.querySelector('[aria-label="QR-код подключения"]')).not.toBeNull();
  await tick();
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => { box.checked = true; Simulate.change(box); });
  await act(async () => button("Это моё устройство — разрешить вход").click());
  await act(async () => root.render(null)); await tick(0);
  expect(devicesApi.reject).not.toHaveBeenCalled();
});

it("parses an invitation in StrictMode and clears the URL fragment without losing it", async () => {
  const invite = { kind: "invite" as const, id, key: provider.publicKey, secret: "s".repeat(43) };
  window.history.replaceState(null, "", deviceLink(invite));
  vi.mocked(devicesApi.accept).mockImplementation(async (_id, body) => latest = { ...base(), kind: "invite", state: "claimed", receiver_public_key: body.public_key, approver_public_key: provider.publicKey, account });
  await act(async () => root.render(createElement(StrictMode, null, createElement(MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, createElement(DeviceConnectPage)))));
  expect(devicesApi.accept).toHaveBeenCalledOnce();
  expect(window.location.hash).toBe("");
  expect(host.textContent).toContain("Алиса");
});

it("does not silently switch an already authorized browser to an invited account", async () => {
  state.token = "already-signed-in";
  window.history.replaceState(null, "", deviceLink({ kind: "invite", id, key: provider.publicKey, secret: "s".repeat(43) }));
  await act(async () => root.render(createElement(MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, createElement(DeviceConnectPage))));
  expect(host.textContent).toContain("Вы уже вошли");
  expect(devicesApi.accept).not.toHaveBeenCalled();
  expect(finishDeviceLogin).not.toHaveBeenCalled();
});

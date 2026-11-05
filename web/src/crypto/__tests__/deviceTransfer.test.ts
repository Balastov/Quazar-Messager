import { IDBFactory } from "fake-indexeddb";
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PairView } from "../../api/devices";
import { pairKeys, pairBinding, displayPairCode, inspectTransfer, sealDeviceKeys, openDeviceKeys } from "../deviceTransfer";
import { derivePublicKeyFromSeed, importDeviceIdentities, loadIdentityKeyPair, loadLegacyIdentities, saveIdentitySeed } from "../webcrypto";
import { checkPairUpdate, deviceLink, parseDeviceLink } from "../../auth/deviceLink";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
function flow() {
  const receiver = pairKeys(), approver = pairKeys(), seed = nacl.randomBytes(32);
  const request: PairView = { id: "12345678-1234-4321-8123-123456789abc", kind: "request", state: "approved",
    receiver_public_key: receiver.publicKey, approver_public_key: approver.publicKey,
    account: { id: "alice", username: "alice", display_name: "Алиса", avatar_url: null }, account_public_key: derivePublicKeyFromSeed(seed),
    device_name: "Safari · iPhone", created_at: "2026-11-05T12:00:00Z", expires_at: "2026-11-05T12:02:00Z", transferred_keys: true };
  return { receiver, approver, seed, request };
}

it("transfers the current seed and only historical keys attributed to the same account", async () => {
  const { receiver, approver, seed, request } = flow();
  const other = nacl.randomBytes(32), unknown = nacl.randomBytes(32), previous = nacl.randomBytes(32);
  await saveIdentitySeed(other, "bob");
  await saveIdentitySeed(unknown);
  await saveIdentitySeed(previous, "alice");
  await saveIdentitySeed(seed, "alice");
  const summary = await inspectTransfer(request);
  expect(summary.available).toBe(true); expect(summary.skippedArchives).toBe(1);
  const box = (await sealDeviceKeys(request, approver))!;
  const wire = JSON.stringify(box);
  for (const value of [seed, previous, other, unknown]) expect(wire).not.toContain(encodeBase64(value));
  const decoded = await openDeviceKeys(box, request, receiver);
  expect(decoded.seed).toEqual(seed);
  expect(decoded.archived).toEqual([previous]);
});

it("imports transferred keys atomically and preserves another local account's identity", async () => {
  const { seed } = flow(), history = nacl.randomBytes(32), localOther = nacl.randomBytes(32);
  await saveIdentitySeed(localOther, "bob");
  await importDeviceIdentities("alice", seed, [history]);
  const current = await loadIdentityKeyPair(), old = await loadLegacyIdentities();
  expect(current?.publicKey).toBe(derivePublicKeyFromSeed(seed));
  expect(current?.accountId).toBe("alice");
  expect(old.find(key => key.publicKey === derivePublicKeyFromSeed(history))?.accountId).toBe("alice");
  expect(old.find(key => key.publicKey === derivePublicKeyFromSeed(localOther))?.accountId).toBe("bob");
});

it("rejects ciphertext modification and a different receiving private key", async () => {
  const { receiver, approver, seed, request } = flow();
  await saveIdentitySeed(seed, "alice");
  const box = (await sealDeviceKeys(request, approver))!;
  const changed = decodeBase64(box.ciphertext); changed[20] ^= 1;
  await expect(openDeviceKeys({ ...box, ciphertext: encodeBase64(changed) }, request, receiver)).rejects.toThrow();
  await expect(openDeviceKeys(box, request, { publicKey: receiver.publicKey, secretKey: pairKeys().secretKey })).rejects.toThrow();
});

it("binds transferred material to the account, request and both device keys", async () => {
  const { receiver, approver, seed, request } = flow();
  await saveIdentitySeed(seed, "alice");
  const box = (await sealDeviceKeys(request, approver))!;
  await expect(openDeviceKeys(box, { ...request, id: "87654321-1234-4321-8123-123456789abc" }, receiver)).rejects.toThrow();
  await expect(openDeviceKeys(box, { ...request, account: { ...request.account!, id: "bob" } }, receiver)).rejects.toThrow();
  await expect(sealDeviceKeys(request, pairKeys())).rejects.toThrow();
});

it("does not export a local identity that is not the account's current key", async () => {
  const { approver, request } = flow();
  await saveIdentitySeed(nacl.randomBytes(32), "bob");
  expect((await inspectTransfer(request)).available).toBe(false);
  await expect(sealDeviceKeys(request, approver)).rejects.toThrow();
});

it("generates the same comparison code and changes it for another transcript", async () => {
  const { request } = flow();
  const binding = await pairBinding(request);
  expect(binding).toMatch(/^[a-f0-9]{64}$/);
  expect(displayPairCode(binding)).toMatch(/^[A-F0-9]{4}( [A-F0-9]{4}){3}$/);
  expect(await pairBinding({ ...request })).toBe(binding);
  expect(await pairBinding({ ...request, device_name: "Другой браузер" })).not.toBe(binding);
});

it("keeps the claimed transcript immutable and ignores older status replies", () => {
  const { request, receiver } = flow();
  const consumed = { ...request, state: "consumed" as const };
  expect(checkPairUpdate(consumed, { ...request, state: "claimed" }, receiver, true)).toBe(consumed);
  expect(() => checkPairUpdate(request, { ...request, account_public_key: pairKeys().publicKey }, receiver, true)).toThrow();
  expect(() => checkPairUpdate(request, { ...request, approver_public_key: pairKeys().publicKey }, receiver, true)).toThrow();
});

it("accepts only the app's own device links and never includes a receiving secret", () => {
  const { receiver } = flow();
  const link = { kind: "request" as const, id: "12345678-1234-4321-8123-123456789abc", key: receiver.publicKey };
  const url = deviceLink(link);
  expect(parseDeviceLink(url)).toEqual(link);
  expect(url).not.toContain("receiver_secret");
  for (const value of [url.replace(window.location.origin, "https://wrong.example"), url + "&id=other", "javascript:alert(1)"]) {
    expect(() => parseDeviceLink(value)).toThrow();
  }
});

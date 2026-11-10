import { IDBFactory } from "fake-indexeddb";
import nacl from "tweetnacl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let crypto: typeof import("../webcrypto");
beforeEach(async () => { vi.resetModules(); vi.stubGlobal("indexedDB", new IDBFactory()); crypto = await import("../webcrypto"); });
afterEach(() => vi.unstubAllGlobals());

it("forgets the current and archived keys of one account only", async () => {
  const bobOld = nacl.randomBytes(32), aliceOld = nacl.randomBytes(32), alice = nacl.randomBytes(32);
  // Архив: старый ключ Боба и прежний ключ Алисы; текущий — Алисы.
  await crypto.saveIdentitySeed(bobOld, "bob");
  await crypto.importDeviceIdentities("alice", alice, [aliceOld]);
  expect((await crypto.loadIdentityKeyPair())?.accountId).toBe("alice");
  expect((await crypto.loadLegacyIdentities()).map((key) => key.accountId).sort()).toEqual(["alice", "bob"]);

  await crypto.forgetAccountKeys("alice");
  expect(await crypto.loadIdentityKeyPair()).toBeNull();
  const left = await crypto.loadLegacyIdentities();
  expect(left.map((key) => key.accountId)).toEqual(["bob"]);
  expect(left[0].publicKey).toBe(crypto.derivePublicKeyFromSeed(bobOld));
});

it("keeps another account's current key", async () => {
  await crypto.saveIdentitySeed(nacl.randomBytes(32), "bob");
  await crypto.forgetAccountKeys("alice");
  expect((await crypto.loadIdentityKeyPair())?.accountId).toBe("bob");
});

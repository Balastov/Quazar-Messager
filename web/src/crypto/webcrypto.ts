/**
 * Identity keys: seed-based X25519 (NaCl) + optional WebCrypto CryptoKey for legacy.
 * Seed нужен для backup/restore (фаза 3). Runtime decrypt — через seed или deriveBits.
 */
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";

const DB_NAME = "quazar-crypto";
const DB_VERSION = 2;
const STORE = "keys";
const RECORD_ID = "identity";

const SIGMA = new Uint8Array([
  101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107,
]);
const ZEROS16 = new Uint8Array(16);

type NaclLowlevel = {
  crypto_core_hsalsa20: (
    out: Uint8Array,
    inp: Uint8Array,
    k: Uint8Array,
    c: Uint8Array
  ) => void;
};

const lowlevel = (nacl as unknown as { lowlevel: NaclLowlevel }).lowlevel;

interface StoredIdentity {
  id: typeof RECORD_ID;
  publicKeyB64: string;
  /** 32-byte seed; required for new keys / backup. */
  seed?: ArrayBuffer;
  /** Legacy phase-1 non-exportable key (no seed). */
  privateKey?: CryptoKey;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function loadStoredIdentity(): Promise<StoredIdentity | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(RECORD_ID);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    req.onsuccess = () => resolve((req.result as StoredIdentity | undefined) ?? null);
  });
}

async function putIdentity(record: StoredIdentity): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put(record);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB write failed"));
    req.onsuccess = () => resolve();
  });
}

function seedToBuffer(seed: Uint8Array): ArrayBuffer {
  return seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength) as ArrayBuffer;
}

export async function generateIdentityKeyPair(): Promise<{
  publicKey: string;
  seed: Uint8Array;
}> {
  const seed = nacl.randomBytes(32);
  const naclPair = nacl.box.keyPair.fromSecretKey(seed);
  const publicKeyB64 = encodeBase64(naclPair.publicKey);

  await putIdentity({
    id: RECORD_ID,
    publicKeyB64,
    seed: seedToBuffer(seed),
  });

  return { publicKey: publicKeyB64, seed };
}

export async function restoreIdentityFromSeed(seedB64: string): Promise<{
  publicKey: string;
}> {
  const seed = decodeBase64(seedB64);
  if (seed.length !== 32) {
    throw new Error("Invalid seed length");
  }
  const naclPair = nacl.box.keyPair.fromSecretKey(seed);
  const publicKeyB64 = encodeBase64(naclPair.publicKey);
  await putIdentity({
    id: RECORD_ID,
    publicKeyB64,
    seed: seedToBuffer(seed),
  });
  return { publicKey: publicKeyB64 };
}

export async function loadIdentityKeyPair(): Promise<{
  publicKey: string;
  privateKey: CryptoKey | null;
  seed: Uint8Array | null;
} | null> {
  const stored = await loadStoredIdentity();
  if (!stored) return null;
  return {
    publicKey: stored.publicKeyB64,
    privateKey: stored.privateKey ?? null,
    seed: stored.seed ? new Uint8Array(stored.seed) : null,
  };
}

export async function getIdentitySeed(): Promise<Uint8Array | null> {
  const stored = await loadStoredIdentity();
  if (!stored?.seed) return null;
  return new Uint8Array(stored.seed);
}

export async function clearIdentityKeys(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(RECORD_ID);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB delete failed"));
    req.onsuccess = () => resolve();
  });
}

/** NaCl crypto_box_beforenm using WebCrypto-derived shared secret (legacy keys). */
export async function deriveBoxSharedKey(
  privateKey: CryptoKey,
  theirPublicKeyRaw: Uint8Array
): Promise<Uint8Array> {
  const keyBuffer = new Uint8Array(theirPublicKeyRaw);
  const theirPublicKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "X25519" },
    false,
    []
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "X25519", public: theirPublicKey },
    privateKey,
    256
  );

  const scalar = new Uint8Array(bits);
  const sharedKey = new Uint8Array(32);
  lowlevel.crypto_core_hsalsa20(sharedKey, ZEROS16, scalar, SIGMA);
  return sharedKey;
}

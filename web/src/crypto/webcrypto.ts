/**
 * Non-exportable X25519 identity keys via Web Crypto API + IndexedDB.
 */
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";

const DB_NAME = "quazar-crypto";
const DB_VERSION = 1;
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
  privateKey: CryptoKey;
  publicKeyB64: string;
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

async function saveIdentity(privateKey: CryptoKey, publicKeyB64: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const record: StoredIdentity = { id: RECORD_ID, privateKey, publicKeyB64 };
    const req = tx.objectStore(STORE).put(record);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB write failed"));
    req.onsuccess = () => resolve();
  });
}

export async function generateIdentityKeyPair(): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
}> {
  const keyPair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;

  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyB64 = encodeBase64(new Uint8Array(publicKeyRaw));

  await saveIdentity(keyPair.privateKey, publicKeyB64);

  return { publicKey: publicKeyB64, privateKey: keyPair.privateKey };
}

export async function loadIdentityKeyPair(): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
} | null> {
  const stored = await loadStoredIdentity();
  if (!stored) return null;
  return { publicKey: stored.publicKeyB64, privateKey: stored.privateKey };
}

/** NaCl crypto_box_beforenm using WebCrypto-derived shared secret. */
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

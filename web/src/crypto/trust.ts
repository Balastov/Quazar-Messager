/**
 * TOFU (Trust On First Use) — локальное хранилище доверенных публичных ключей.
 */
import { computeFingerprint } from "./fingerprint";
import { fetchUserPublicKey, invalidateKeyCache } from "./keys";

const STORAGE_KEY = "quazar_trusted_keys";

export type TrustStatus = "ok" | "new" | "unverified" | "changed" | "missing";

export interface TrustedKeyRecord {
  publicKey: string;
  fingerprint: string;
  trustedAt: string;
  verifiedAt?: string;
}

export interface TrustCheckResult {
  status: TrustStatus;
  publicKey: string | null;
  fingerprint: string | null;
  verified: boolean;
}

interface TrustedKeyStore {
  [userId: string]: TrustedKeyRecord;
}

function loadStore(): TrustedKeyStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TrustedKeyStore) : {};
  } catch {
    return {};
  }
}

function saveStore(store: TrustedKeyStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function getTrustedKey(userId: string): TrustedKeyRecord | null {
  return loadStore()[userId] ?? null;
}

function upsertRecord(
  userId: string,
  publicKey: string,
  fingerprint: string,
  verifiedAt?: string
): TrustedKeyRecord {
  const store = loadStore();
  const existing = store[userId];
  const record: TrustedKeyRecord = {
    publicKey,
    fingerprint,
    trustedAt: existing?.trustedAt ?? new Date().toISOString(),
    verifiedAt: verifiedAt ?? existing?.verifiedAt,
  };
  store[userId] = record;
  saveStore(store);
  return record;
}

export async function resolvePeerTrust(
  userId: string,
  myPublicKey: string,
  serverPublicKey?: string | null
): Promise<TrustCheckResult> {
  const publicKey = serverPublicKey ?? (await fetchUserPublicKey(userId));
  if (!publicKey) {
    return { status: "missing", publicKey: null, fingerprint: null, verified: false };
  }

  const fingerprint = await computeFingerprint(myPublicKey, publicKey);
  const trusted = getTrustedKey(userId);

  if (!trusted) {
    upsertRecord(userId, publicKey, fingerprint);
    return { status: "new", publicKey, fingerprint, verified: false };
  }

  if (trusted.publicKey !== publicKey) {
    return { status: "changed", publicKey, fingerprint, verified: false };
  }

  if (trusted.verifiedAt) {
    return { status: "ok", publicKey, fingerprint, verified: true };
  }

  return { status: "unverified", publicKey, fingerprint, verified: false };
}

export async function markPeerVerified(userId: string, myPublicKey: string): Promise<void> {
  const trusted = getTrustedKey(userId);
  if (!trusted) return;

  const fingerprint = await computeFingerprint(myPublicKey, trusted.publicKey);
  upsertRecord(userId, trusted.publicKey, fingerprint, new Date().toISOString());
}

export async function acceptPeerKeyChange(
  userId: string,
  myPublicKey: string,
  newPublicKey: string
): Promise<void> {
  const fingerprint = await computeFingerprint(myPublicKey, newPublicKey);
  upsertRecord(userId, newPublicKey, fingerprint, new Date().toISOString());
  invalidateKeyCache(userId);
}

export function clearPeerTrust(userId: string): void {
  const store = loadStore();
  delete store[userId];
  saveStore(store);
}

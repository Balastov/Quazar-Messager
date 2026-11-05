import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import type { EncryptedDeviceKeys, PairView } from "../api/devices";
import { bindIdentityToAccount, derivePublicKeyFromSeed, loadIdentityKeyPair, loadLegacyIdentities, type LocalIdentity } from "./webcrypto";

export interface PairKeys { publicKey: string; secretKey: Uint8Array }
export interface TransferredKeys { seed: Uint8Array; archived: Uint8Array[] }
const MAX_ARCHIVED = 256;

export function pairKeys(): PairKeys {
  const key = nacl.box.keyPair();
  return { publicKey: encodeBase64(key.publicKey), secretKey: key.secretKey };
}
export function receiverSecret(): string {
  return encodeBase64(nacl.randomBytes(32)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function publicKey(value: string): Uint8Array {
  const raw = decodeBase64(value);
  if (raw.length !== 32 || encodeBase64(raw) !== value || nacl.scalarMult(new Uint8Array(32).fill(9), raw).every(byte => byte === 0)) throw new Error("Некорректный ключ устройства");
  return raw;
}

export async function pairBinding(flow: PairView): Promise<string> {
  if (!flow.account || !flow.receiver_public_key || !flow.approver_public_key) throw new Error("Подключение ещё не готово");
  const data = ["quazar-device-v1", flow.id, flow.receiver_public_key, flow.approver_public_key,
    flow.account.id, flow.account_public_key || "", flow.device_name];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

export function displayPairCode(binding: string): string {
  return binding.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(" ");
}

function exportable(identity: LocalIdentity | null): boolean {
  try { return !!identity?.seed && derivePublicKeyFromSeed(identity.seed) === identity.publicKey; }
  catch { return false; }
}

export async function inspectTransfer(flow: PairView) {
  if (!flow.account_public_key) return { available: true, needsKeys: false, skippedArchives: 0 };
  const identity = await loadIdentityKeyPair();
  const available = exportable(identity) && identity!.publicKey === flow.account_public_key;
  const old = await loadLegacyIdentities();
  return { available, needsKeys: true, skippedArchives: old.filter(key => !key.accountId || (key.accountId === flow.account?.id && !exportable(key))).length };
}

export async function sealDeviceKeys(flow: PairView, keys: PairKeys): Promise<EncryptedDeviceKeys | null> {
  if (flow.approver_public_key !== keys.publicKey || !flow.account || !flow.receiver_public_key) throw new Error("Ключ подключения изменился. Начните заново");
  if (!flow.account_public_key) return null;
  const identity = await loadIdentityKeyPair();
  if (!identity?.seed || !exportable(identity) || identity.publicKey !== flow.account_public_key) throw new Error("На этом устройстве нет ключа текущей переписки");
  await bindIdentityToAccount(flow.account.id, flow.account_public_key);
  const archived = (await loadLegacyIdentities()).filter(key => key.accountId === flow.account!.id && exportable(key) && key.publicKey !== identity.publicKey);
  if (archived.length > MAX_ARCHIVED) throw new Error("Слишком много архивных ключей для одного подключения");
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, request_id: flow.id, user_id: flow.account.id,
    binding: await pairBinding(flow), public_key: identity.publicKey, seed: encodeBase64(identity.seed),
    archived: archived.map(key => ({ public_key: key.publicKey, seed: encodeBase64(key.seed!) })) }));
  try {
    return { nonce: encodeBase64(nonce), ciphertext: encodeBase64(nacl.box(plaintext, nonce, publicKey(flow.receiver_public_key), keys.secretKey)) };
  } finally { plaintext.fill(0); }
}

export async function openDeviceKeys(box: EncryptedDeviceKeys, flow: PairView, keys: PairKeys): Promise<TransferredKeys> {
  if (flow.receiver_public_key !== keys.publicKey || !flow.approver_public_key || !flow.account || !flow.account_public_key) throw new Error("Запрос подключения изменился");
  const nonce = decodeBase64(box.nonce), ciphertext = decodeBase64(box.ciphertext);
  if (nonce.length !== nacl.box.nonceLength || ciphertext.length > 75_000) throw new Error("Некорректный пакет ключей");
  const plaintext = nacl.box.open(ciphertext, nonce, publicKey(flow.approver_public_key), keys.secretKey);
  if (!plaintext) throw new Error("Не удалось проверить зашифрованные ключи. Начните подключение заново");
  try {
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    if (data.version !== 1 || data.request_id !== flow.id || data.user_id !== flow.account.id || data.binding !== await pairBinding(flow) ||
      data.public_key !== flow.account_public_key || typeof data.seed !== "string" || !Array.isArray(data.archived) || data.archived.length > MAX_ARCHIVED) throw new Error("Пакет ключей относится к другому подключению");
    const seed = decodeBase64(data.seed);
    if (derivePublicKeyFromSeed(seed) !== flow.account_public_key) throw new Error("Ключ переписки не совпадает с ключом аккаунта");
    const archived = data.archived.map((entry: { seed: string; public_key: string }) => {
      const value = decodeBase64(entry.seed);
      if (derivePublicKeyFromSeed(value) !== entry.public_key) throw new Error("Повреждён архивный ключ");
      return value;
    });
    return { seed, archived };
  } finally { plaintext.fill(0); }
}

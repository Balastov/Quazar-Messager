import { devicesApi, type PairConsumption, type PairView } from "../api/devices";
import { publicOrigin } from "../platform/desktop";
import { derivePublicKeyFromSeed, importDeviceIdentities } from "../crypto/webcrypto";
import { openDeviceKeys, publicKey, type PairKeys, type TransferredKeys } from "../crypto/deviceTransfer";

export type DeviceLink = { kind: "request"; id: string; key: string } | { kind: "invite"; id: string; key: string; secret: string };
const b64url = (value: string) => value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = (value: string) => {
  const raw = value.replace(/-/g, "+").replace(/_/g, "/");
  const key = raw + "=".repeat((4 - raw.length % 4) % 4);
  publicKey(key); return key;
};

export function deviceLink(link: DeviceLink): string {
  const hash = new URLSearchParams({ type: link.kind, id: link.id, key: b64url(link.key) });
  if (link.kind === "invite") hash.set("invite", link.secret);
  return `${publicOrigin()}/connect#${hash}`;
}

export function parseDeviceLink(value: string): DeviceLink {
  const url = new URL(value);
  if (url.origin !== publicOrigin() || url.pathname !== "/connect" || url.search || url.username || url.password) throw new Error("Это не QR-код подключения Quazar");
  const data = new URLSearchParams(url.hash.slice(1));
  if ([...data.keys()].some(key => !["type", "id", "key", "invite"].includes(key) || data.getAll(key).length !== 1)) throw new Error("Некорректный QR-код подключения");
  const kind = data.get("type"), id = data.get("id") ?? "";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !["request", "invite"].includes(kind ?? "")) throw new Error("Некорректный QR-код подключения");
  const key = fromUrl(data.get("key") ?? "");
  if (kind === "request") return { kind, id, key };
  const secret = data.get("invite") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Некорректное приглашение");
  return { kind: "invite", id, key, secret };
}

export function checkPairKey(flow: PairView, keys: PairKeys, receiver: boolean): void {
  if ((receiver ? flow.receiver_public_key : flow.approver_public_key) !== keys.publicKey) throw new Error("Ключ подключения изменился. Начните заново");
}

function descriptor(flow: PairView): string {
  return JSON.stringify([flow.id, flow.kind, flow.receiver_public_key, flow.approver_public_key,
    flow.account?.id, flow.account_public_key, flow.device_name]);
}

/** Pin the transcript once claimed and ignore older poll responses after approval. */
export function checkPairUpdate(previous: PairView | null, next: PairView, keys: PairKeys, receiver: boolean): PairView {
  checkPairKey(next, keys, receiver);
  if (previous && (previous.id !== next.id || previous.kind !== next.kind)) throw new Error("Запрос подключения изменился");
  if (previous?.account && previous.receiver_public_key && previous.approver_public_key && descriptor(previous) !== descriptor(next)) {
    throw new Error("Данные подключения изменились. Создайте новый QR-код");
  }
  const rank = { offered: 0, pending: 0, claimed: 1, approved: 2, consumed: 3, expired: 4, rejected: 4 };
  if (previous && rank[previous.state] > rank[next.state] && !(previous.state === "expired" && next.state === "approved" && Date.parse(next.expires_at) > Date.now())) return previous;
  return next;
}

function browserAlreadySignedIn(): boolean {
  try { return !!JSON.parse(localStorage.getItem("quazar-auth") ?? "null")?.state?.token; }
  catch { return false; }
}

export async function finishDeviceLogin(result: PairConsumption, keys: PairKeys, expected: PairView): Promise<void> {
  const { useAuthStore } = await import("../store/auth");
  const flow = result.request;
  let transferred: TransferredKeys | null = null;
  try {
    checkPairKey(flow, keys, true);
    if (flow.state !== "consumed" || !["approved", "consumed"].includes(expected.state)) throw new Error("Вход ещё не подтверждён");
    checkPairUpdate(expected, flow, keys, true);
    if (!flow.account || useAuthStore.getState().token || browserAlreadySignedIn()) throw new Error("В этом браузере уже выполнен вход. Сначала выйдите из аккаунта");
    if (result.encrypted_keys) transferred = await openDeviceKeys(result.encrypted_keys, flow, keys);
    if (flow.transferred_keys && !transferred) throw new Error("Пакет переписки не получен. Повторите подключение");
    await useAuthStore.getState().setToken(result.access_token, async user => {
      if (user.id !== flow.account!.id || browserAlreadySignedIn()) throw new Error("Аккаунт подключения изменился. Начните заново");
      const current = await devicesApi.accountKey(user.id, result.access_token);
      if (current !== flow.account_public_key) throw new Error("Ключ аккаунта изменился. Подключитесь заново");
      if (transferred) {
        if (derivePublicKeyFromSeed(transferred.seed) !== current) throw new Error("Ключ переписки не совпадает");
        await importDeviceIdentities(user.id, transferred.seed, transferred.archived);
      }
    });
  } catch (error) {
    void devicesApi.discard(result.access_token).catch(() => {});
    throw error;
  } finally {
    transferred?.seed.fill(0); transferred?.archived.forEach(seed => seed.fill(0));
  }
}

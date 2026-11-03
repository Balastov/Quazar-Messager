import {http} from "../api/client";

let endpoint: string | null = null;
let owner: string | null = null;
let generation = 0;
let ackTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Set<string>();
const handled = new Map<string, number>();
const pushed = new Set<string>();

export function isAppFocused(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

export function setNotificationUser(userId: string | null) {
  if (owner === userId) return;
  owner = userId; generation++; endpoint = null; handled.clear(); pushed.clear(); pending.clear();
  if (ackTimer) clearTimeout(ackTimer);
  ackTimer = null;
}
export function setPushEndpoint(value: string | null) {endpoint = value;}
export function notificationGeneration() {return generation;}

export function claimNotification(id?: string, recipientId?: string): boolean {
  if (!owner || (recipientId && recipientId !== owner)) return false;
  if (!id) return true;
  if (handled.has(id)) return false;
  handled.set(id, Date.now());
  if (handled.size > 2000) handled.delete(handled.keys().next().value!);
  return true;
}

export function pushWasShown(id: string, userId?: string) {
  if (userId && userId !== owner) return;
  claimNotification(id);
  pushed.add(id);
  if (pushed.size > 2000) pushed.delete(pushed.values().next().value!);
}
export function wasPushShown(id?: string) {return !!id && pushed.has(id);}

/** ACK только от устройства, которое реально показало уведомление или обработало сообщение в фокусе. */
export function acknowledgeMessage(id: string, displayed = false) {
  if ((!displayed && !isAppFocused()) || !endpoint || !owner) return;
  pending.add(id);
  if (ackTimer) return;
  ackTimer = setTimeout(() => {
    ackTimer = null;
    const ids = [...pending].slice(0, 100); ids.forEach(item => pending.delete(item));
    const target = endpoint;
    if (!target || !ids.length) return;
    void http.post("/push/ack", {endpoint: target, message_ids: ids}).catch(() => {});
    if (pending.size) acknowledgeMessage([...pending][0], true);
  }, 80);
}

/** ready может ждать бесконечно. Уведомление должно иметь работающий запасной путь. */
export async function notificationRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const bound = async <T,>(promise: Promise<T> | undefined, ms: number): Promise<T | null> => {
    if (!promise) return null;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), ms);
      promise.then(value => {clearTimeout(timer); resolve(value);}).catch(() => {clearTimeout(timer); resolve(null);});
    });
  };
  try {
    const existing = await bound(navigator.serviceWorker.getRegistration?.(), 300);
    if (existing?.active) return existing;
    return await bound(navigator.serviceWorker.ready, 700);
  } catch {return null;}
}

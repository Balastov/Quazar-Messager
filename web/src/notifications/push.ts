import { http } from "../api/client";
import { desktop } from "../platform/desktop";
import { browserPermission, getNotifyPrefs, subscribeNotifyPrefs } from "./prefs";
import {notificationRegistration, setPushEndpoint} from "./delivery";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let activeSubscription: PushSubscription | null = null;
let inFlight: Promise<boolean> | null = null;
let epoch = 0;
let lifecycleStarted = false;
let resyncNeeded = false;
let requestedPrefs = "";

export function ensurePushSubscription(): Promise<boolean> {
  const prefs = getNotifyPrefs();
  const snapshot = JSON.stringify([prefs.enabled, prefs.sound]);
  if (inFlight) {if (snapshot !== requestedPrefs) resyncNeeded = true; return inFlight;}
  requestedPrefs = snapshot;
  const round = epoch;
  const task = ensure(round).finally(() => {
    if (inFlight !== task) return;
    inFlight = null;
    if (resyncNeeded) {resyncNeeded = false; void ensurePushSubscription();}
  });
  inFlight = task;
  return task;
}

async function ensure(round: number): Promise<boolean> {
  if (desktop()) return false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !http.defaults.headers.common.Authorization) return false;
  // Разрешение запрашивается кнопкой пользователя, а не фоновым эффектом после входа.
  if (browserPermission() !== "granted") return false;
  try {
    const {data} = await http.get<{publicKey: string | null; configured: boolean}>("/push/vapid-public-key");
    if (!data.configured || !data.publicKey || round !== epoch) return false;
    const reg = await notificationRegistration();
    if (!reg || round !== epoch) return false;
    let sub = await reg.pushManager.getSubscription();
    const key = urlBase64ToUint8Array(data.publicKey);
    const oldKey = sub?.options?.applicationServerKey;
    if (sub && oldKey && (new Uint8Array(oldKey).length !== key.length || new Uint8Array(oldKey).some((value, index) => value !== key[index]))) {
      await sub.unsubscribe(); sub = null;
    }
    const prefs = getNotifyPrefs();
    if (!sub && !prefs.enabled) return false;
    sub ??= await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key as BufferSource});
    if (round !== epoch) {await sub.unsubscribe(); return false;}
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
    await http.post("/push/subscribe", {endpoint: json.endpoint, keys: {p256dh: json.keys.p256dh, auth: json.keys.auth},
      user_agent: navigator.userAgent.slice(0, 500), enabled: prefs.enabled, sound: prefs.sound});
    if (round !== epoch) {await sub.unsubscribe(); return false;}
    activeSubscription = sub; setPushEndpoint(json.endpoint);
    return true;
  } catch {return false;}
}

export async function dropPushSubscription(): Promise<void> {
  epoch++; inFlight = null; resyncNeeded = false; setPushEndpoint(null);
  const authorization = http.defaults.headers.common.Authorization;
  const cached = activeSubscription; activeSubscription = null;
  try {
    const sub = cached ?? await (await notificationRegistration())?.pushManager.getSubscription();
    if (!sub) return;
    const tasks: Promise<unknown>[] = [sub.unsubscribe()];
    if (authorization) tasks.push(http.delete("/push/subscribe", {data: {endpoint: sub.endpoint}, headers: {Authorization: authorization}}).catch(() => {}));
    await Promise.all(tasks);
  } catch { /* Browser unsubscribe is best effort when storage/permission was removed. */ }
}

export function startPushLifecycle() {
  if (lifecycleStarted || typeof window === "undefined") return;
  lifecycleStarted = true;
  const refresh = () => {void ensurePushSubscription();};
  window.addEventListener("online", refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {if (document.visibilityState === "visible") refresh();});
  try {navigator.serviceWorker?.addEventListener("controllerchange", refresh);} catch { /* blocked browser storage */ }
  subscribeNotifyPrefs(refresh);
  setInterval(() => {if (document.visibilityState === "visible") refresh();}, 120_000);
}

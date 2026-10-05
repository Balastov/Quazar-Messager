import { http } from "../api/client";
import { browserPermission, getNotifyPrefs } from "./prefs";
import { requestNotifyPermission } from "./notify";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function ensurePushSubscription(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (!getNotifyPrefs().enabled) return false;

  let perm = browserPermission();
  if (perm === "default") {
    perm = await requestNotifyPermission();
  }
  if (perm !== "granted") return false;

  try {
    const { data } = await http.get<{ publicKey: string | null; configured: boolean }>(
      "/push/vapid-public-key"
    );
    if (!data.configured || !data.publicKey) return false;

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey) as BufferSource,
      });
    }

    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

    await http.post("/push/subscribe", {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      user_agent: navigator.userAgent.slice(0, 500),
    });
    return true;
  } catch {
    return false;
  }
}

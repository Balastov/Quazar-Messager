import { desktop } from "./desktop";
import { useCallStore } from "../store/call";
import { useVoiceStore } from "../store/voice";
import { useAuthStore } from "../store/auth";
import { socket } from "../ws/socket";

export function startDesktop() {
  const bridge = desktop();
  if (!bridge) return;
  const busy = () => {
    const call = useCallStore.getState().phase;
    bridge.setSessionBusy((call !== "idle" && call !== "ended") || useVoiceStore.getState().status !== "idle");
  };
  busy(); useCallStore.subscribe(busy); useVoiceStore.subscribe(busy);
  const authReturn = (fragment: string) => window.location.assign(`/auth/yandex${fragment}`);
  bridge.onAuthReturn(authReturn);
  void bridge.takeAuthReturn().then(fragment => { if (fragment) authReturn(fragment); }).catch(() => {});
  useAuthStore.subscribe((state, before) => { if (state.user?.id !== before.user?.id) bridge.clearNotifications(); });
  bridge.onNavigate(route => {
    if (route.kind === "resume") { socket.reconnectNow(); window.dispatchEvent(new Event("online")); }
    else if (route.kind === "door" && route.starId && route.channelId) window.dispatchEvent(new CustomEvent("quazar-star-door", { detail: route }));
    else if (route.kind === "star" && route.starId && route.channelId) window.dispatchEvent(new CustomEvent("quazar-open-star", { detail: route }));
    else if (route.kind === "call" && route.callId) window.dispatchEvent(new CustomEvent("quazar-open-call", { detail: route }));
    else if (route.chatId) window.dispatchEvent(new CustomEvent("quazar-open-chat", { detail: route }));
  });
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { capturePendingInvite } from "./api/stars";
import { registerNotifyServiceWorker } from "./notifications/notify";
import { useUiStore } from "./store/ui";
import { applyGlassTransparency } from "./styles/glass";
import "./index.css";

applyGlassTransparency(useUiStore.getState().glassTransparency);
useUiStore.subscribe((st, prev) => {
  if (st.glassTransparency !== prev.glassTransparency) {
    applyGlassTransparency(st.glassTransparency);
  }
});

// Ссылка-приглашение в Звезду могла открыться до входа — запоминаем её.
capturePendingInvite();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

void registerNotifyServiceWorker();

type SwCallMsg = {
  type?: string;
  callId?: string | null;
  chatId?: string | null;
  callerId?: string | null;
  callerName?: string | null;
  media?: { audio: boolean; video: boolean } | null;
};

function handleCallMessage(data: SwCallMsg) {
  if (!data?.type) return;
  if (data.type === "quazar-star-door") {
    window.dispatchEvent(
      new CustomEvent("quazar-star-door", { detail: (data as { link?: unknown }).link })
    );
    return;
  }
  if (data.type === "quazar-open-star") {
    const link = data as { starId?: string; channelId?: string };
    window.dispatchEvent(new CustomEvent("quazar-open-star", { detail: { starId: link.starId, channelId: link.channelId } }));
    return;
  }
  if (data.type === "quazar-open-chat" && data.chatId) {
    window.dispatchEvent(
      new CustomEvent("quazar-open-chat", { detail: { chatId: data.chatId } })
    );
    return;
  }
  if (
    data.type === "quazar-open-call" ||
    data.type === "quazar-accept-call" ||
    data.type === "quazar-reject-call"
  ) {
    window.dispatchEvent(
      new CustomEvent(data.type, {
        detail: {
          callId: data.callId,
          chatId: data.chatId,
          callerId: data.callerId,
          callerName: data.callerName,
          media: data.media,
        },
      })
    );
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    handleCallMessage(event.data as SwCallMsg);
  });
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerNotifyServiceWorker } from "./notifications/notify";
import "./index.css";

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

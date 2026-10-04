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

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; chatId?: string | null };
    if (data?.type === "quazar-open-chat" && data.chatId) {
      window.dispatchEvent(
        new CustomEvent("quazar-open-chat", { detail: { chatId: data.chatId } })
      );
    }
  });
}
